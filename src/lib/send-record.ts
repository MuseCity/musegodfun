import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient } from "viem";
import { sameAddress } from "./config";
import { walletRefusedUnsent } from "./wallet-signing";

// ---- a wallet send recorded before the wallet receives it ---------------------------------------------------------------------
// A flow that must never pay twice (the $10 launch fee, an ETH buy through LI.FI) writes its record right before the wallet receives the
// request ("sending", with the account's pending nonce and the head block), upgrades it at the hash ("pending"), and lets only a definite
// answer remove it: the wallet's rejection or unprocessed refusal before any hash, the chain (below), or the user's explicit choice. The
// chain decides by the saved hash, a replacement the wallet reported, or the nonce: a spent nonce never changes, so its transaction is
// found once (`NonceMemo`).

/** What every recorded send keeps: `nonceSeen` says the nonce is the one the sent transaction really used, not the predicted one. */
export type SentAttempt = { from: Address; nonce?: number; block?: string } &
  ({ state: "sending"; nonce: number; block: string } | { state: "pending"; txHash: Hex; nonceSeen?: true });
export type SentResolution<A> =
  | { status: "confirmed"; hash: Hex } // Exactly this transaction succeeded, with two confirmations on the canonical chain.
  | { status: "reverted"; hash: Hex } // Exactly this transaction failed, with two confirmations on the canonical chain.
  | { status: "cancelled" } // Another transaction spent its nonce: a replacement the wallet reported, or a nonce the sent transaction used.
  | { status: "waiting"; record?: A } // A known transaction is still confirming (`record`: the same, now with its seen nonce).
  | { status: "unknown" }; // No proof either way: only the user may clear it.
export type SendReader = Pick<PublicClient, "getBlockNumber" | "getTransactionReceipt" | "getTransaction" | "getTransactionCount" | "getBlock">;
type ChainTransaction = Awaited<ReturnType<PublicClient["getTransaction"]>>;
/** The mined transaction at a spent nonce, which never changes. */
export type NonceTransaction = Pick<ChainTransaction, "hash" | "from" | "to" | "input" | "value" | "nonce">;
/** Spent nonces of one wallet on one chain, found once and never searched again. */
export type NonceMemo = Map<number, NonceTransaction>;
const missing = (error: unknown) => {
  if (error instanceof TransactionReceiptNotFoundError || error instanceof TransactionNotFoundError) return null;
  throw error;
};
/** The first block whose state counts more than `nonce` transactions from `from` holds that transaction (a binary search over
 * `eth_getTransactionCount`, from `low`, the head when the send was requested). */
export async function transactionAtNonce(client: SendReader, from: Address, nonce: number, low: bigint, head: bigint): Promise<NonceTransaction | null> {
  const count = (blockNumber: bigint) => client.getTransactionCount({ address: from, blockNumber });
  let lo = low > head ? head : low, hi = head;
  if (await count(lo) > nonce) lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await count(mid) > nonce) hi = mid; else lo = mid + 1n;
  }
  const block = await client.getBlock({ blockNumber: lo, includeTransactions: true });
  const found = block.transactions.find((tx) => typeof tx !== "string" && sameAddress(tx.from, from) && tx.nonce === nonce);
  return found && typeof found !== "string" ? found : null;
}
/** Decides a recorded send from the chain alone; throws on RPC failure, and the caller asks again later. `matches`: exactly the recorded
 * transaction (its sender, target, calldata and value).
 * 1. `hint`, a replacement the wallet reported, spent the same nonce: it is adopted when it matches, otherwise it cancelled the send.
 * 2. The saved hash: its receipt decides, and while it is in the mempool the send is waiting (its real nonce is then recorded).
 * 3. The nonce, read at the same head the search ends at: unspent means not mined yet. A spent nonce is final, so the transaction at it is
 *    found once (`memo`). It is adopted only when it matches. Another transaction there proves a cancellation only for a nonce the sent
 *    transaction really used; for a predicted nonce the next three nonces are checked too, then the user decides.
 * A receipt decides, a failure as much as a success, only with two confirmations in the block that is still the chain's block at its
 * height (as the server's verifyLaunchFeePayment accepts one); before that the send is waiting. */
export async function resolveSentTransaction<A extends SentAttempt>(client: SendReader, record: A, matches: (tx: NonceTransaction) => boolean,
  hint?: Hex, memo: NonceMemo = new Map()): Promise<SentResolution<A>> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const settled = async (hash: Hex): Promise<SentResolution<A> | null> => {
    const receipt = await client.getTransactionReceipt({ hash }).catch(missing);
    if (!receipt) return null;
    if (head < receipt.blockNumber + 1n || (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) return { status: "waiting" };
    return { status: receipt.status === "success" ? "confirmed" : "reverted", hash: receipt.transactionHash };
  };
  if (hint) {
    const replacement = await client.getTransaction({ hash: hint }).catch(missing);
    if (replacement && replacement.blockNumber !== null && sameAddress(replacement.from, record.from))
      return matches(replacement) ? await settled(replacement.hash) ?? { status: "waiting" } : { status: "cancelled" };
  }
  let nonce = record.nonce, nonceSeen = record.state === "pending" && !!record.nonceSeen;
  if (record.state === "pending") {
    const sent = await client.getTransaction({ hash: record.txHash }).catch(missing);
    if (sent && matches(sent)) {
      const result = await settled(sent.hash);
      if (result) return result;
      return { status: "waiting", ...(record.nonceSeen && record.nonce === sent.nonce ? {} : { record: { ...record, nonce: sent.nonce, nonceSeen: true } }) };
    }
    if (sent) { nonce = sent.nonce; nonceSeen = true; }
  }
  if (nonce === undefined) return { status: "unknown" };
  const spent = await client.getTransactionCount({ address: record.from, blockNumber: head });
  if (spent <= nonce) return record.state === "pending" ? { status: "waiting" } : { status: "unknown" };
  const atNonce = async (n: number) => {
    const saved = memo.get(n);
    if (saved) return saved;
    const found = await transactionAtNonce(client, record.from, n, BigInt(record.block ?? "0"), head);
    if (found) memo.set(n, { hash: found.hash, from: found.from, to: found.to, input: found.input, value: found.value, nonce: found.nonce });
    return found;
  };
  const first = await atNonce(nonce);
  if (first && matches(first)) return await settled(first.hash) ?? { status: "waiting" };
  if (first && nonceSeen) return { status: "cancelled" };
  // The predicted nonce went elsewhere: the wallet may have queued other transactions before this one.
  for (let next = nonce + 1; first && next <= nonce + 3 && next < spent; next++) {
    const tx = await atNonce(next);
    if (tx && matches(tx)) return await settled(tx.hash) ?? { status: "waiting" };
  }
  return { status: "unknown" };
}

/** The wallet said no: EIP-1193 4001 (viem's UserRejectedRequestError), anywhere in the error's cause chain. */
export function isUserRejection(error: unknown): boolean {
  for (let cause = error as { code?: unknown; name?: unknown; cause?: unknown } | undefined, depth = 0; cause && depth < 10; depth++) {
    if (cause.code === 4001 || cause.name === "UserRejectedRequestError") return true;
    cause = cause.cause as typeof cause;
  }
  return false;
}
/** What is left of a recorded attempt (`current`, the one written at `attemptAt`) after the wallet request failed: before any hash, a
 * user rejection or a wallet refusal that proves nothing was processed clears it; anything else may have been broadcast, so it stays for
 * the chain checks. A record without `at` (a settled one) or another attempt's is never touched. */
export function attemptAfterSendError<R extends { state: string }>(current: R | null, attemptAt: number, error: unknown): R | null {
  if (!current || (current as { at?: unknown }).at !== attemptAt) return current;
  return current.state === "sending" && (isUserRejection(error) || walletRefusedUnsent(error)) ? null : current;
}

// ---- how often an open record is checked --------------------------------------------------------------------------------------
export const SEND_POLL_WAITING_MS = 4_000;
export const SEND_POLL_BACKOFF_MS = [60_000, 120_000, 300_000] as const;
/** What one check found: decided (the record is gone), waiting for a known transaction's receipt, or undecided; "error": the check failed. */
export type SendPollStatus = "decided" | "waiting" | "unknown" | "error";
/** A send waiting for its receipt costs about three reads and is checked every 4 s. An undecided one, or a failed check, backs off to 1, 2
 * and then 5 minutes, so an open tab never crowds the shared read budget. null: decided. */
export function sendPollDelay(status: SendPollStatus, slowChecks: number): number | null {
  if (status === "decided") return null;
  if (status === "waiting") return SEND_POLL_WAITING_MS;
  return SEND_POLL_BACKOFF_MS[Math.min(Math.max(slowChecks, 1), SEND_POLL_BACKOFF_MS.length) - 1];
}
type Timers = { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void };
/** Runs `check` now and then as `sendPollDelay` says. It pauses while the page is hidden (`resume` catches up) and `now` re-checks at once,
 * restarting the back-off. */
export function createSendPoller(check: () => Promise<SendPollStatus>, hidden: () => boolean = () => typeof document !== "undefined" && document.hidden,
  timers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) }) {
  let timer: unknown, slowChecks = 0, running = false, stopped = false, due = false;
  async function run() {
    timer = undefined;
    if (stopped || running) return;
    if (hidden()) { due = true; return; }
    running = true;
    const status = await check().catch(() => "error" as const);
    running = false;
    if (stopped) return;
    slowChecks = status === "unknown" || status === "error" ? slowChecks + 1 : 0;
    const delay = sendPollDelay(status, slowChecks);
    if (delay !== null) timer = timers.set(() => void run(), delay);
  }
  return {
    start: () => void run(),
    stop: () => { stopped = true; timers.clear(timer); },
    now: () => { timers.clear(timer); slowChecks = 0; void run(); },
    resume: () => { if (due && !hidden()) { due = false; void run(); } },
  };
}
