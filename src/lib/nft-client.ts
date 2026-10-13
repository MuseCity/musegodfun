import { encodeFunctionData, erc20Abi, formatUnits, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex,
  type PublicClient } from "viem";
import { z } from "zod";
import { deploymentChain, sameAddress, type RuntimeConfig } from "./config";
import { LAUNCH_FEE_STABLE } from "./launch-fee";
import { isMuse, type NftRef, type NftStatus } from "./nft-mode";
import { chainApi } from "./api";
import { launchIntentStorageKey } from "./launch-intent";
import { addressSchema, hashSchema, launchFeeSchema, type LaunchInput } from "./validation";

export type LaunchFeeQuote = { wei: string; expiresAt: number; mac: Hex };
type FeeConfig = Pick<RuntimeConfig, "mode" | "deploymentChainId" | "treasury">;

export function launchFeeStableTx(config: FeeConfig) {
  const stable = LAUNCH_FEE_STABLE[deploymentChain(config)];
  if (!stable || !config.treasury) throw new Error("The launch fee cannot be paid with a stablecoin on this network.");
  return { to: stable.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [config.treasury, stable.amount] }), value: 0n as const };
}
export function launchFeeEthTx(config: FeeConfig, quote: LaunchFeeQuote) {
  if (!config.treasury) throw new Error("The platform treasury is not configured.");
  return { to: config.treasury, data: "0x" as const, value: BigInt(quote.wei) };
}
/** Exactly a launch-fee payment: the 10 USDG transfer above, or a plain transfer of exactly the quoted wei to the treasury.
 * The wallet signs nothing near it; an ETH payment without its quote is refused. */
export function isLaunchFeeTx(config: FeeConfig, tx: { to: Address; data: Hex; value: bigint }, quote?: LaunchFeeQuote): boolean {
  try {
    const stable = launchFeeStableTx(config);
    if (sameAddress(tx.to, stable.to) && tx.data.toLowerCase() === stable.data.toLowerCase() && tx.value === 0n) return true;
  } catch { /* No stablecoin fee on this network. */ }
  return !!quote && !!config.treasury && sameAddress(tx.to, config.treasury) && tx.data === "0x" && tx.value === BigInt(quote.wei);
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
/** Why the review must wait, or null. In NFT mode a coin never launches without its confirmed NFT, so it can never fall back to a normal coin. */
export function nftReviewBlocker(nftMode: boolean, draft: Pick<LaunchInput, "nft" | "launchFee">, stepStatus: string, fee: LaunchFeeState = "none"): string | null {
  if (!nftMode) return null;
  if (!draft.nft) return stepStatus.trim() || "Check the NFT before you review the launch.";
  if (isMuse(draft.nft) || draft.launchFee) return null;
  if (fee === "sending") return "A launch fee payment may have been sent. Check its status in the NFT step before you continue.";
  if (fee === "pending") return "Your $10 launch fee payment is still confirming. Review opens once it has two confirmations.";
  return "Pay the $10 launch fee for this NFT first.";
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
type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
/** Earlier builds kept the fee per draft at `<payment key of the intent>.launch-fee`. The first one found moves to the wallet's record
 * once, and only when the wallet has none; the others stay where they are. */
export function migrateLaunchFee(storage: KeyValueStorage, config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId">, account: Address) {
  const target = launchFeeStorageKey(config, account), prefix = target.slice(0, -LAUNCH_FEE_LOCK.length);
  if (storage.getItem(target)) return;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key || key === target || !key.startsWith(prefix) || !key.endsWith(`.${LAUNCH_FEE_LOCK}`)) continue;
    try {
      const { pending, ...fee } = JSON.parse(storage.getItem(key) || "null") ?? {};
      const parsed = launchFeeSchema.safeParse(fee);
      if (!parsed.success || (pending !== undefined && pending !== true)) continue;
      const { txHash, asset, ...quote } = parsed.data as DraftLaunchFee & Partial<LaunchFeeQuote>;
      const record: LaunchFeeRecord = pending
        ? { state: "pending", asset, from: account, at: 0, txHash, ...(asset === "native" ? { quote: quote as LaunchFeeQuote } : {}) }
        : { state: "paid", from: account, fee: parsed.data };
      storage.setItem(target, JSON.stringify(record));
      storage.removeItem(key);
      return;
    } catch { /* An unreadable record of an earlier build stays where it is. */ }
  }
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
/** What is left of an attempt after `wallet.send` failed: only a wallet rejection before any hash clears it; anything else may have
 * been broadcast, so the record stays for the nonce check. */
export function launchFeeAfterSendError(current: LaunchFeeRecord | null, attemptAt: number, error: unknown): LaunchFeeRecord | null {
  if (!current || current.state === "paid" || current.at !== attemptAt) return current;
  return current.state === "sending" && isUserRejection(error) ? null : current;
}

export const FEE_REVERTED = "The launch fee payment failed on-chain, so no fee was paid. You can pay again.";
export const FEE_CANCELLED = "No fee was paid; the payment was cancelled.";
export const FEE_MAYBE_SENT = "A payment may have been sent. Check your wallet's activity.";
export type FeeResolution =
  | { status: "paid"; fee: DraftLaunchFee }
  | { status: "failed"; reason: string } // Definitely no fee: the caller removes the record.
  | { status: "waiting"; record?: LaunchFeeAttempt } // A known payment is still confirming (`record`: the same, now with its seen nonce).
  | { status: "unknown"; reason: string }; // No proof either way: the caller offers "No payment was sent — pay again".
type FeeReader = Pick<PublicClient, "getBlockNumber" | "getTransactionReceipt" | "getTransaction" | "getTransactionCount" | "getBlock">;
type ChainTransaction = Awaited<ReturnType<PublicClient["getTransaction"]>>;
const missing = (error: unknown) => {
  if (error instanceof TransactionReceiptNotFoundError || error instanceof TransactionNotFoundError) return null;
  throw error;
};
/** The first block whose state counts more than `nonce` transactions from `from` holds that transaction (a binary search over
 * `eth_getTransactionCount`, from `low`, the head when the payment was requested). */
export async function transactionAtNonce(client: FeeReader, from: Address, nonce: number, low: bigint, head: bigint): Promise<ChainTransaction | null> {
  const count = (blockNumber: bigint) => client.getTransactionCount({ address: from, blockNumber });
  let lo = low > head ? head : low, hi = head;
  if (await count(lo) > nonce) lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await count(mid) > nonce) hi = mid; else lo = mid + 1n;
  }
  const block = await client.getBlock({ blockNumber: lo, includeTransactions: true });
  const found = block.transactions.find((tx) => typeof tx !== "string" && sameAddress(tx.from, from) && tx.nonce === nonce);
  return found && typeof found !== "string" ? found as ChainTransaction : null;
}
/** Decides an attempt from the chain alone. A known hash's receipt decides first (also `hint`, a replacement the wallet reported);
 * otherwise the nonce does: unspent means not mined yet, and once spent the transaction at that nonce is adopted only when it is
 * exactly this fee (a speed-up keeps target, data and value). Throws on RPC failure; the caller asks again later. */
export async function resolveLaunchFee(client: FeeReader, config: FeeConfig, record: LaunchFeeAttempt, hint?: Hex): Promise<FeeResolution> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const isFee = (tx: ChainTransaction) => sameAddress(tx.from, record.from) && !!tx.to &&
    isLaunchFeeTx(config, { to: tx.to, data: tx.input, value: tx.value }, record.quote);
  const settled = async (tx: ChainTransaction): Promise<FeeResolution | null> => {
    const receipt = await client.getTransactionReceipt({ hash: tx.hash }).catch(missing);
    if (!receipt) return null;
    if (receipt.status !== "success") return { status: "failed", reason: FEE_REVERTED };
    if (head < receipt.blockNumber + 1n) return { status: "waiting" };
    return { status: "paid", fee: launchFeeOf(record.asset, receipt.transactionHash, record.quote) };
  };
  if (hint) {
    const replacement = await client.getTransaction({ hash: hint }).catch(missing);
    if (replacement && isFee(replacement) && (record.nonce === undefined || replacement.nonce === record.nonce)) {
      const result = await settled(replacement);
      if (result) return result;
    }
  }
  let nonce = record.nonce, nonceSeen = record.state === "pending" && !!record.nonceSeen;
  if (record.state === "pending") {
    const sent = await client.getTransaction({ hash: record.txHash }).catch(missing);
    if (sent && isFee(sent)) {
      const result = await settled(sent);
      if (result) return result;
      return { status: "waiting", ...(record.nonceSeen && record.nonce === sent.nonce ? {} : { record: { ...record, nonce: sent.nonce, nonceSeen: true } }) };
    }
    if (sent) { nonce = sent.nonce; nonceSeen = true; }
  }
  if (nonce === undefined) return { status: "unknown", reason: FEE_MAYBE_SENT };
  const spent = await client.getTransactionCount({ address: record.from, blockTag: "latest" });
  if (spent <= nonce) return record.state === "pending" ? { status: "waiting" } : { status: "unknown", reason: FEE_MAYBE_SENT };
  const tx = await transactionAtNonce(client, record.from, nonce, BigInt(record.block ?? "0"), head);
  if (tx && isFee(tx)) return await settled(tx) ?? { status: "waiting" };
  // A different transaction spent the nonce. That proves no fee only when the nonce is the one the sent payment really used.
  return tx && nonceSeen ? { status: "failed", reason: FEE_CANCELLED } : { status: "unknown", reason: FEE_MAYBE_SENT };
}
