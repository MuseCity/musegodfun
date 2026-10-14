import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient } from "viem";
import { sameAddress } from "./config";
import { walletRefusedUnsent } from "./wallet-signing";

// ---- a wallet send recorded before the wallet receives it ---------------------------------------------------------------------
// A flow that must never pay twice (the $10 launch fee, an ETH buy through LI.FI) writes its record right before the wallet receives the
// request ("sending", with the account's pending nonce and the head block), upgrades it at the hash ("pending"), and lets only a definite
// answer remove it: the wallet's rejection or unprocessed refusal before any hash, the chain (below), or the user's explicit choice. The
// chain decides by the saved hash, a replacement the wallet reported, or the nonce, and only from stable state (two confirmations in the
// canonical block); the transaction at a spent nonce is searched once it is stable (`NonceMemo`). The record is written at the wallet
// request itself, under a re-verified cross-tab lease (`recordAtBroadcast`).

/** What every recorded send keeps: `at` identifies the attempt (written when the wallet received it); `nonceSeen` says the nonce is the one
 * the sent transaction really used, not the predicted one. */
export type SentAttempt = { from: Address; at: number; nonce?: number; block?: string } &
  ({ state: "sending"; nonce: number; block: string } | { state: "pending"; txHash: Hex; nonceSeen?: true });
export type SentResolution<A> =
  | { status: "confirmed"; hash: Hex } // Exactly this transaction succeeded, with two confirmations on the canonical chain.
  | { status: "reverted"; hash: Hex } // Exactly this transaction failed, with two confirmations on the canonical chain.
  | { status: "cancelled" } // Another transaction spent its nonce: a replacement the wallet reported, or a nonce the sent transaction used.
  | { status: "waiting"; record?: A } // A known transaction is still confirming (`record`: the same, now with its seen nonce).
  | { status: "unknown" }; // No proof either way: only the user may clear it.
export type SendReader = Pick<PublicClient, "getBlockNumber" | "getTransactionReceipt" | "getTransaction" | "getTransactionCount" | "getBlock">;
type ChainTransaction = Awaited<ReturnType<PublicClient["getTransaction"]>>;
/** A transaction compared with a recorded send. */
export type NonceTransaction = Pick<ChainTransaction, "hash" | "from" | "to" | "input" | "value" | "nonce">;
/** The transaction the nonce search found at a spent nonce, with the block that held it when it was read. */
export type NonceFound = NonceTransaction & { blockNumber: bigint; blockHash: Hex };
/** Spent nonces of one wallet on one chain, found once and not searched again: only stable ones (two confirmations, in the block that was
 * canonical when it was read), and a remembered one whose receipt no longer decides is dropped and searched again. */
export type NonceMemo = Map<number, NonceFound>;
const missing = (error: unknown) => {
  if (error instanceof TransactionReceiptNotFoundError || error instanceof TransactionNotFoundError) return null;
  throw error;
};
/** The first block whose state counts more than `nonce` transactions from `from` holds that transaction (a binary search over
 * `eth_getTransactionCount`, from `low`, the head when the send was requested). */
export async function transactionAtNonce(client: SendReader, from: Address, nonce: number, low: bigint, head: bigint): Promise<NonceFound | null> {
  const count = (blockNumber: bigint) => client.getTransactionCount({ address: from, blockNumber });
  let lo = low > head ? head : low, hi = head;
  if (await count(lo) > nonce) lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await count(mid) > nonce) hi = mid; else lo = mid + 1n;
  }
  const block = await client.getBlock({ blockNumber: lo, includeTransactions: true });
  const found = block.transactions.find((tx) => typeof tx !== "string" && sameAddress(tx.from, from) && tx.nonce === nonce);
  return found && typeof found !== "string" && block.hash ? { hash: found.hash, from: found.from, to: found.to, input: found.input, value: found.value,
    nonce: found.nonce, blockNumber: lo, blockHash: block.hash } : null;
}
/** How long a sent transaction the node has no trace of still counts as on its way (propagating) while its nonce is unspent. After that it
 * may never have left the wallet (dropped, or replaced before it was seen), so the user decides, as for an unconfirmed attempt. */
export const SEND_UNSEEN_GRACE_MS = 120_000;
/** Decides a recorded send from the chain alone; throws on RPC failure, and the caller asks again later. `matches`: exactly the recorded
 * transaction (its sender, target, calldata and value). Only stable chain state decides: a block with two confirmations that is still the
 * chain's block at its height (as the server's verifyLaunchFeePayment accepts a receipt). Anything newer is waiting, and is read again.
 * 1. `hint`, a replacement the wallet reported, spent the same nonce: it is adopted when it matches, otherwise it cancelled the send.
 * 2. The saved hash: its receipt decides, and while the node holds it unmined the send is waiting (its real nonce is then recorded). A sent
 *    transaction the node has no trace of, with its nonce unspent, is waiting for SEND_UNSEEN_GRACE_MS after `at`; then the user decides.
 * 3. The nonce, read at the same head the search ends at: unspent means not mined yet. The transaction at a spent nonce is found by a
 *    search and remembered in `memo` once stable; a remembered one whose receipt no longer decides (it vanished, or its block left the
 *    canonical chain in a deeper reorganization) is forgotten and searched again. It is adopted only when it matches. Another transaction
 *    there proves a cancellation only for a nonce the sent transaction really used; for a predicted nonce the next three nonces are checked
 *    too, then the user decides. */
export async function resolveSentTransaction<A extends SentAttempt>(client: SendReader, record: A, matches: (tx: NonceTransaction) => boolean,
  hint?: Hex, memo: NonceMemo = new Map(), now = Date.now()): Promise<SentResolution<A>> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const stable = (blockNumber: bigint) => head >= blockNumber + 1n;
  const canonical = async (blockNumber: bigint, blockHash: Hex | null) =>
    stable(blockNumber) && !!blockHash && (await client.getBlock({ blockNumber })).hash === blockHash;
  const settled = async (hash: Hex): Promise<SentResolution<A> | null> => {
    const receipt = await client.getTransactionReceipt({ hash }).catch(missing);
    if (!receipt) return null;
    if (!await canonical(receipt.blockNumber, receipt.blockHash)) return { status: "waiting" };
    return { status: receipt.status === "success" ? "confirmed" : "reverted", hash: receipt.transactionHash };
  };
  if (hint) {
    const replacement = await client.getTransaction({ hash: hint }).catch(missing);
    if (replacement && replacement.blockNumber !== null && sameAddress(replacement.from, record.from)) {
      if (matches(replacement)) return await settled(replacement.hash) ?? { status: "waiting" };
      return await canonical(replacement.blockNumber, replacement.blockHash) ? { status: "cancelled" } : { status: "waiting" };
    }
  }
  let nonce = record.nonce, nonceSeen = record.state === "pending" && !!record.nonceSeen, unseen = false;
  if (record.state === "pending") {
    const sent = await client.getTransaction({ hash: record.txHash }).catch(missing);
    if (sent && matches(sent)) {
      const result = await settled(sent.hash);
      if (result) return result;
      return { status: "waiting", ...(record.nonceSeen && record.nonce === sent.nonce ? {} : { record: { ...record, nonce: sent.nonce, nonceSeen: true } }) };
    }
    if (sent) { nonce = sent.nonce; nonceSeen = true; } else unseen = true;
  }
  if (nonce === undefined) return { status: "unknown" };
  const spent = await client.getTransactionCount({ address: record.from, blockNumber: head });
  if (spent <= nonce) return record.state === "pending" && (!unseen || now - record.at < SEND_UNSEEN_GRACE_MS) ? { status: "waiting" } : { status: "unknown" };
  // The transaction at `n` (remembered only once stable) and, when it matches, what its receipt decides. A remembered one whose receipt no
  // longer decides is forgotten, and the nonce searched again once.
  const atNonce = async (n: number): Promise<{ tx: NonceFound | null; result?: SentResolution<A> }> => {
    for (let fresh = false; ; fresh = true) {
      const remembered = memo.get(n);
      const tx = remembered ?? await transactionAtNonce(client, record.from, n, BigInt(record.block ?? "0"), head);
      if (tx && !remembered && stable(tx.blockNumber)) memo.set(n, tx);
      if (!tx || !matches(tx)) return { tx };
      const result = await settled(tx.hash);
      if (remembered && !fresh && (!result || result.status === "waiting")) { memo.delete(n); continue; }
      return { tx, result: result ?? { status: "waiting" } };
    }
  };
  const first = await atNonce(nonce);
  if (first.result) return first.result;
  // Another transaction spent the nonce the sent one used: final once that transaction is stable.
  if (first.tx && nonceSeen) return stable(first.tx.blockNumber) ? { status: "cancelled" } : { status: "waiting" };
  // The predicted nonce went elsewhere: the wallet may have queued other transactions before this one.
  for (let next = nonce + 1; first.tx && next <= nonce + 3 && next < spent; next++) {
    const later = await atNonce(next);
    if (later.result) return later.result;
  }
  return { status: "unknown" };
}

export const SEND_LEASE_LOST = "This tab lost its hold on this wallet's payment while it waited, so nothing was sent. Check whether another tab paid, then try again.";
/** The broadcast step of a recorded send, run as the signer's `beforeSend`: right before the wallet receives the request, and again before
 * every resend the signing policy allows. The cross-tab lease is verified (renewed) first, so a tab suspended past its lease never sends
 * after another tab took over; a record of another attempt (another `at`, nonce or wallet) is never overwritten (`taken`: why it refuses);
 * then this attempt's record is written. A refusal throws, and the wallet receives nothing. Nothing awaits between the renewed lease and the
 * wallet request, so the renewed lease covers it. */
export async function recordAtBroadcast<R extends { from: Address; at: number; nonce?: number }>(record: R, { assertHeld, read, write, taken }:
  { assertHeld: () => Promise<void>; read: () => unknown; write: (record: R) => void; taken: string }) {
  try { await assertHeld(); } catch { throw new Error(SEND_LEASE_LOST); }
  const current = read() as Partial<R> | null;
  if (current && !(current.at === record.at && current.nonce === record.nonce && typeof current.from === "string" && sameAddress(current.from, record.from)))
    throw new Error(taken);
  write(record);
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
