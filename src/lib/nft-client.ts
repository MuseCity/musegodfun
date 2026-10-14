import { encodeFunctionData, erc20Abi, formatUnits, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex,
  type PublicClient } from "viem";
import { z } from "zod";
import { deploymentChain, sameAddress, type RuntimeConfig, type TokenRecord } from "./config";
import { LAUNCH_FEE_MAX_WEI, LAUNCH_FEE_STABLE } from "./launch-fee";
import { isMuse, nftKey, type NftRef, type NftStatus } from "./nft-mode";
import { chainApi } from "./api";
import { launchIntentStorageKey } from "./launch-intent";
import { addressSchema, hashSchema, launchFeeSchema, type LaunchInput } from "./validation";
import { walletRefusedUnsent } from "./wallet-signing";

export type LaunchFeeQuote = { wei: string; expiresAt: number; mac: Hex };
type FeeConfig = Pick<RuntimeConfig, "mode" | "deploymentChainId" | "treasury">;

export function launchFeeStableTx(config: FeeConfig) {
  const stable = LAUNCH_FEE_STABLE[deploymentChain(config)];
  if (!stable || !config.treasury) throw new Error("The launch fee cannot be paid with a stablecoin on this network.");
  return { to: stable.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [config.treasury, stable.amount] }), value: 0n as const };
}
export const FEE_QUOTE_TOO_HIGH = "The ETH price quote is too high to be safe. Pay with USDG, or try again later.";
/** A quote the wallet may pay: at most LAUNCH_FEE_MAX_WEI. */
export const saneFeeQuote = (quote: Pick<LaunchFeeQuote, "wei">) => BigInt(quote.wei) <= LAUNCH_FEE_MAX_WEI;
export function launchFeeEthTx(config: FeeConfig, quote: LaunchFeeQuote) {
  if (!config.treasury) throw new Error("The platform treasury is not configured.");
  if (!saneFeeQuote(quote)) throw new Error(FEE_QUOTE_TOO_HIGH);
  return { to: config.treasury, data: "0x" as const, value: BigInt(quote.wei) };
}
/** Exactly a launch-fee payment: the 10 USDG transfer above, or a plain transfer of exactly the quoted wei to the treasury, never above
 * LAUNCH_FEE_MAX_WEI. The wallet signs nothing near it; an ETH payment without its quote is refused. */
export function isLaunchFeeTx(config: FeeConfig, tx: { to: Address; data: Hex; value: bigint }, quote?: LaunchFeeQuote): boolean {
  try {
    const stable = launchFeeStableTx(config);
    if (sameAddress(tx.to, stable.to) && tx.data.toLowerCase() === stable.data.toLowerCase() && tx.value === 0n) return true;
  } catch { /* No stablecoin fee on this network. */ }
  return !!quote && saneFeeQuote(quote) && !!config.treasury && sameAddress(tx.to, config.treasury) && tx.data === "0x" && tx.value === BigInt(quote.wei);
}
/** The quoted ETH, rounded up to 6 decimals so the page never shows less than the wallet will send. */
export function formatFeeEth(wei: string): string {
  const step = 10n ** 12n;
  return formatUnits((BigInt(wei) + step - 1n) / step, 6);
}
/** The server re-checks all of this at prepare; the check here only guides the form. */
export function readNftStatus(config: Pick<RuntimeConfig, "mode" | "deploymentChainId">, nft: NftRef, account: Address) {
  return chainApi<NftStatus>(deploymentChain(config),
    `/nft-status?nft=${encodeURIComponent(`${nft.chainId}:${nft.contract}:${nft.tokenId}`)}&account=${account}`);
}

/** Ruling: a launch fee is consumed per creator, not per NFT, so the draft keeps it across NFT changes. Only a paid NFT launch sends it. */
export function prepareDraft(draft: LaunchInput): LaunchInput {
  if (draft.nft && !isMuse(draft.nft)) return draft;
  const { launchFee: _unused, ...rest } = draft;
  return rest;
}
/** Where the fee payment stands, as the NFT step shows it. */
export type LaunchFeeState = "none" | "sending" | "pending" | "paid";
/** What the NFT step's live check passed for: the NFT (`nftKey`) and the wallet account. */
export type NftChecked = { nft: string; account: string };
/** Whether the step's check passed for exactly this draft's NFT and this wallet. A restored NFT stays in the draft while it is checked
 * again, and a wallet switch fails this at once, before the step reports its new check. */
export function nftCheckPassed(draft: Pick<LaunchInput, "nft">, checked: NftChecked | null, account: string | null): boolean {
  return !!draft.nft && !!checked && !!account && checked.nft === nftKey(draft.nft) && checked.account.toLowerCase() === account.toLowerCase();
}
/** Why the review must wait, or null. In NFT mode a coin never launches without its confirmed NFT, so it can never fall back to a normal coin. */
export function nftReviewBlocker(nftMode: boolean, draft: Pick<LaunchInput, "nft" | "launchFee">, stepStatus: string, fee: LaunchFeeState = "none",
  checked: NftChecked | null = null, account: string | null = null): string | null {
  if (!nftMode) return null;
  if (!draft.nft || !nftCheckPassed(draft, checked, account)) return stepStatus.trim() || "Check the NFT before you review the launch.";
  if (isMuse(draft.nft) || draft.launchFee) return null;
  if (fee === "sending") return "A launch fee payment may have been sent. Check its status in the NFT step before you continue.";
  if (fee === "pending") return "Your $10 launch fee payment is still confirming. Review opens once it has two confirmations.";
  return "Pay the $10 launch fee for this NFT first.";
}
/** The $10 in a non-Muse NFT draft's Launch cost (spec §6.5): paid, or still due before launch. Empty for Muses and normal drafts. */
export function nftLaunchFeeCost(draft: Pick<LaunchInput, "nft" | "launchFee">): string {
  return draft.nft && !isMuse(draft.nft) ? `$10 launch fee (${draft.launchFee ? "paid" : "due before launch"})` : "";
}
/** Rewards: whose creator share it is. NFT coins pay theirs to the NFT's treasury, so a launcher whose coins are all NFT coins is told
 * that instead of "you keep", and a launcher with a mix gets one more sentence. `share`: the creator share, as a percent. */
export function rewardsShareCopy(coins: Pick<TokenRecord, "nft">[], share: string): { lede: string; tile: string; allNft: boolean } {
  const nftCoins = coins.filter((coin) => coin.nft).length;
  if (nftCoins && nftCoins === coins.length) return { allNft: true, tile: "NFT treasury share",
    lede: `All your launches are NFT coins. NFT coins pay their ${share} creator share to the NFT's treasury, which the NFT's holder controls.` };
  const normal = `You keep ${share} of every trading fee on new launches. Fees stay on-chain until you claim them.`;
  return { allNft: false, tile: "Your creator share",
    lede: nftCoins ? `${normal} NFT coins pay their creator share to the NFT's treasury instead.` : normal };
}
/** NFT mode is saved with the draft, so a reload while the NFT check is pending stays in NFT mode. */
export function savedNftMode(raw: string | null): boolean {
  try {
    const saved = JSON.parse(raw || "null");
    return saved?.nftMode === true || (!!saved?.nft && typeof saved.nft === "object");
  } catch { return false; }
}
/** Fields a Muse's name fills: only empty ones. The symbol is the name's letters, at most 10, in upper case. */
export function musePrefill(draft: Pick<LaunchInput, "name" | "symbol">, museName: string): { name?: string; symbol?: string } {
  const name = museName.trim().slice(0, 32), symbol = name.replace(/[^A-Za-z]/g, "").slice(0, 10).toUpperCase();
  return { ...(!draft.name.trim() && name ? { name } : {}), ...(!draft.symbol.trim() && symbol ? { symbol } : {}) };
}

// ---- the $10 fee, recorded per creator --------------------------------------------------------
// The server spends a fee per creator, so one record per chain and wallet serves every draft of that wallet. It is written right before
// the wallet receives the request ("sending", with the account's pending nonce), upgraded at the hash ("pending"), and becomes "paid"
// after two confirmations. Only a definite answer removes it: a wallet rejection, a reverted payment, its nonce spent by another
// transaction, a registration that used it, the server's NFT_FEE_USED, or the user's explicit choice.
/** A paid fee as the draft carries it (the launch schema's shape). */
export type DraftLaunchFee = NonNullable<LaunchInput["launchFee"]>;
type Attempt = { asset: DraftLaunchFee["asset"]; from: Address; at: number; quote?: LaunchFeeQuote; nonce?: number; block?: string };
export type LaunchFeeRecord =
  | (Attempt & { state: "sending"; nonce: number; block: string })
  | (Attempt & { state: "pending"; txHash: Hex; nonceSeen?: true })
  | { state: "paid"; from: Address; fee: DraftLaunchFee };
export type LaunchFeeAttempt = Exclude<LaunchFeeRecord, { state: "paid" }>;

const quoteSchema = z.object({ wei: z.string().regex(/^[1-9]\d{0,38}$/), expiresAt: z.number().int().positive(),
  mac: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((h) => h.toLowerCase() as Hex) }).strict();
const nonceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), blockSchema = z.string().regex(/^\d{1,20}$/);
const attemptFields = { asset: z.enum(["stable", "native"]), from: addressSchema, at: z.number().int().nonnegative(), quote: quoteSchema.optional(),
  nonce: nonceSchema.optional(), block: blockSchema.optional() };
const recordSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("sending"), ...attemptFields, nonce: nonceSchema, block: blockSchema }).strict(),
  z.object({ state: z.literal("pending"), ...attemptFields, txHash: hashSchema.transform((h) => h.toLowerCase() as Hex),
    nonceSeen: z.literal(true).optional() }).strict(),
  z.object({ state: z.literal("paid"), from: addressSchema, fee: launchFeeSchema }).strict(),
]).refine((record) => record.state === "paid" || (record.asset === "native") === !!record.quote, "An ETH payment keeps its quote");

/** The reserved intent id of the fee: its record and its cross-tab lock are per chain and wallet, never per launch. */
export const LAUNCH_FEE_LOCK = "launch-fee";
export function launchFeeStorageKey(config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId">, account: Address) {
  return launchIntentStorageKey(config, account, LAUNCH_FEE_LOCK, "payment");
}
export function parseLaunchFeeRecord(raw: string | null): LaunchFeeRecord | null {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw || "null"));
    return parsed.success ? parsed.data as LaunchFeeRecord : null;
  } catch { return null; }
}
/** Drops the wallet's paid fee once it is spent: a registered coin consumed it, or prepare reported it used. */
export function forgetLaunchFee(key: string, txHash: Hex) {
  try {
    const record = parseLaunchFeeRecord(localStorage.getItem(key));
    if (record?.state === "paid" && record.fee.txHash === txHash.toLowerCase()) localStorage.removeItem(key);
  } catch { /* Storage is unavailable; the server refuses a used fee anyway. */ }
}
export function launchFeeOf(asset: DraftLaunchFee["asset"], txHash: Hex, quote?: LaunchFeeQuote): DraftLaunchFee {
  return asset === "native" && quote ? { asset, txHash: txHash.toLowerCase() as Hex, wei: quote.wei, expiresAt: quote.expiresAt, mac: quote.mac }
    : { asset: "stable", txHash: txHash.toLowerCase() as Hex };
}
/** The wallet said no: EIP-1193 4001 (viem's UserRejectedRequestError), anywhere in the error's cause chain. */
export function isUserRejection(error: unknown): boolean {
  for (let cause = error as { code?: unknown; name?: unknown; cause?: unknown } | undefined, depth = 0; cause && depth < 10; depth++) {
    if (cause.code === 4001 || cause.name === "UserRejectedRequestError") return true;
    cause = cause.cause as typeof cause;
  }
  return false;
}
/** What is left of an attempt after `wallet.send` failed: before any hash, a user rejection or a wallet refusal that proves nothing
 * was processed clears it; anything else may have been broadcast, so the record stays for the nonce check. */
export function launchFeeAfterSendError(current: LaunchFeeRecord | null, attemptAt: number, error: unknown): LaunchFeeRecord | null {
  if (!current || current.state === "paid" || current.at !== attemptAt) return current;
  return current.state === "sending" && (isUserRejection(error) || walletRefusedUnsent(error)) ? null : current;
}
export const FEE_WALLET_CANCELLED = "You cancelled the payment in your wallet. No fee was paid.";
export const FEE_WALLET_REFUSED = "Your wallet refused the payment request, and nothing was sent. You can try again or use another wallet.";
/** Why `launchFeeAfterSendError` cleared an attempt: the user's own rejection, or the wallet refusing the request unprocessed. */
export function launchFeeClearedNotice(error: unknown) {
  return isUserRejection(error) ? FEE_WALLET_CANCELLED : FEE_WALLET_REFUSED;
}

export const FEE_REVERTED = "The launch fee payment failed on-chain, so no fee was paid. You can pay again.";
export const FEE_CANCELLED = "No fee was paid; the payment was cancelled.";
export const FEE_MAYBE_SENT = "A payment may have been sent. Check your wallet's activity.";
export const FEE_UNCONFIRMED = "We can't confirm this payment yet. Check your wallet's activity. If no payment left your wallet, choose \u201cNo payment was sent\u201d.";
export type FeeResolution =
  | { status: "paid"; fee: DraftLaunchFee }
  | { status: "failed"; reason: string } // Definitely no fee: the caller removes the record.
  | { status: "waiting"; record?: LaunchFeeAttempt } // A known payment is still confirming (`record`: the same, now with its seen nonce).
  | { status: "unknown"; reason: string }; // No proof either way: the caller offers "No payment was sent — pay again".
type FeeReader = Pick<PublicClient, "getBlockNumber" | "getTransactionReceipt" | "getTransaction" | "getTransactionCount" | "getBlock">;
type ChainTransaction = Awaited<ReturnType<PublicClient["getTransaction"]>>;
/** The mined transaction at a spent nonce, which never changes. */
export type NonceTransaction = Pick<ChainTransaction, "hash" | "from" | "to" | "input" | "value" | "nonce">;
/** Spent nonces of one wallet on one chain, found once and never searched again. */
export type NonceMemo = Map<number, NonceTransaction>;
const missing = (error: unknown) => {
  if (error instanceof TransactionReceiptNotFoundError || error instanceof TransactionNotFoundError) return null;
  throw error;
};
/** Exactly this attempt's fee: the asset it was paid in, so an ETH attempt never adopts a USDG transfer or the reverse. */
export function launchFeeTxMatches(config: FeeConfig, attempt: Pick<LaunchFeeAttempt, "asset" | "from" | "quote">, tx: NonceTransaction): boolean {
  if (!sameAddress(tx.from, attempt.from) || !tx.to) return false;
  if (attempt.asset === "native")
    return !!attempt.quote && !!config.treasury && sameAddress(tx.to, config.treasury) && tx.input === "0x" && tx.value === BigInt(attempt.quote.wei);
  try {
    const stable = launchFeeStableTx(config);
    return sameAddress(tx.to, stable.to) && tx.input.toLowerCase() === stable.data.toLowerCase() && tx.value === 0n;
  } catch { return false; }
}
/** The first block whose state counts more than `nonce` transactions from `from` holds that transaction (a binary search over
 * `eth_getTransactionCount`, from `low`, the head when the payment was requested). */
export async function transactionAtNonce(client: FeeReader, from: Address, nonce: number, low: bigint, head: bigint): Promise<NonceTransaction | null> {
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
/** Decides an attempt from the chain alone; throws on RPC failure, and the caller asks again later.
 * 1. `hint`, a replacement the wallet reported, spent the same nonce: it is adopted when it is exactly this fee, otherwise it cancelled it.
 * 2. The saved hash: its receipt decides, and while it is in the mempool the payment is waiting (its real nonce is then recorded).
 * 3. The nonce, read at the same head the search ends at: unspent means not mined yet. A spent nonce is final, so the transaction at it
 *    is found once (`memo`). It is adopted only when it is exactly this fee. Another transaction there proves no fee only for a nonce the
 *    sent payment really used; for a predicted nonce the next three nonces are checked too, then the user decides. */
export async function resolveLaunchFee(client: FeeReader, config: FeeConfig, record: LaunchFeeAttempt, hint?: Hex, memo: NonceMemo = new Map()):
  Promise<FeeResolution> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const isFee = (tx: NonceTransaction) => launchFeeTxMatches(config, record, tx);
  const settled = async (hash: Hex): Promise<FeeResolution | null> => {
    const receipt = await client.getTransactionReceipt({ hash }).catch(missing);
    if (!receipt) return null;
    if (receipt.status !== "success") return { status: "failed", reason: FEE_REVERTED };
    if (head < receipt.blockNumber + 1n) return { status: "waiting" };
    return { status: "paid", fee: launchFeeOf(record.asset, receipt.transactionHash, record.quote) };
  };
  if (hint) {
    const replacement = await client.getTransaction({ hash: hint }).catch(missing);
    if (replacement && replacement.blockNumber !== null && sameAddress(replacement.from, record.from))
      return isFee(replacement) ? await settled(replacement.hash) ?? { status: "waiting" } : { status: "failed", reason: FEE_CANCELLED };
  }
  let nonce = record.nonce, nonceSeen = record.state === "pending" && !!record.nonceSeen;
  if (record.state === "pending") {
    const sent = await client.getTransaction({ hash: record.txHash }).catch(missing);
    if (sent && isFee(sent)) {
      const result = await settled(sent.hash);
      if (result) return result;
      return { status: "waiting", ...(record.nonceSeen && record.nonce === sent.nonce ? {} : { record: { ...record, nonce: sent.nonce, nonceSeen: true } }) };
    }
    if (sent) { nonce = sent.nonce; nonceSeen = true; }
  }
  if (nonce === undefined) return { status: "unknown", reason: FEE_UNCONFIRMED };
  const spent = await client.getTransactionCount({ address: record.from, blockNumber: head });
  if (spent <= nonce) return record.state === "pending" ? { status: "waiting" } : { status: "unknown", reason: FEE_UNCONFIRMED };
  const atNonce = async (n: number) => {
    const saved = memo.get(n);
    if (saved) return saved;
    const found = await transactionAtNonce(client, record.from, n, BigInt(record.block ?? "0"), head);
    if (found) memo.set(n, { hash: found.hash, from: found.from, to: found.to, input: found.input, value: found.value, nonce: found.nonce });
    return found;
  };
  const first = await atNonce(nonce);
  if (first && isFee(first)) return await settled(first.hash) ?? { status: "waiting" };
  if (first && nonceSeen) return { status: "failed", reason: FEE_CANCELLED };
  // The predicted nonce went elsewhere: the wallet may have queued other transactions before the payment.
  for (let next = nonce + 1; first && next <= nonce + 3 && next < spent; next++) {
    const tx = await atNonce(next);
    if (tx && isFee(tx)) return await settled(tx.hash) ?? { status: "waiting" };
  }
  return { status: "unknown", reason: FEE_UNCONFIRMED };
}

// ---- how often an open attempt is checked ------------------------------------------------------
export const FEE_POLL_WAITING_MS = 4_000;
export const FEE_POLL_BACKOFF_MS = [60_000, 120_000, 300_000] as const;
/** A payment waiting for its receipt costs about three reads and is checked every 4 s. An undecided one, or a failed check, backs off to
 * 1, 2 and then 5 minutes, so an open tab never crowds the shared read budget. null: decided. */
export function feePollDelay(status: FeeResolution["status"] | "error", slowChecks: number): number | null {
  if (status === "paid" || status === "failed") return null;
  if (status === "waiting") return FEE_POLL_WAITING_MS;
  return FEE_POLL_BACKOFF_MS[Math.min(Math.max(slowChecks, 1), FEE_POLL_BACKOFF_MS.length) - 1];
}
type Timers = { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void };
/** Runs `check` now and then as `feePollDelay` says. It pauses while the page is hidden (`resume` catches up) and `now` re-checks at once,
 * restarting the back-off. */
export function createFeePoller(check: () => Promise<FeeResolution["status"]>, hidden: () => boolean = () => typeof document !== "undefined" && document.hidden,
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
    const delay = feePollDelay(status, slowChecks);
    if (delay !== null) timer = timers.set(() => void run(), delay);
  }
  return {
    start: () => void run(),
    stop: () => { stopped = true; timers.clear(timer); },
    now: () => { timers.clear(timer); slowChecks = 0; void run(); },
    resume: () => { if (due && !hidden()) { due = false; void run(); } },
  };
}
