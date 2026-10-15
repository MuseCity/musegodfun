import { encodeFunctionData, erc20Abi, formatUnits, type Address, type Hex } from "viem";
import { z } from "zod";
import { deploymentChain, sameAddress, type RuntimeConfig, type TokenRecord } from "./config";
import { LAUNCH_FEE_MAX_WEI, LAUNCH_FEE_STABLE } from "./launch-fee";
import { isMuse, nftKey, type NftRef, type NftStatus } from "./nft-mode";
import { chainApi } from "./api";
import { reservedLaunchName, type OwnedCollections, type OwnedNfts } from "./nft-holdings";
import { launchIntentStorageKey } from "./launch-intent";
import { addressSchema, hashSchema, launchFeeSchema, type LaunchInput } from "./validation";
import { isUserRejection, resolveSentTransaction, type NonceMemo, type NonceTransaction, type SendReader } from "./send-record";

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
export const FEE_NFT_MODE_OFF = "NFT mode is not available on this network right now; no payment was sent.";
/** Run on the fresh configuration the signer reads right before the wallet receives a launch-fee payment: a fee is paid only while NFT mode
 * is on with a verified vault factory, so a page opened before an operator switched NFT mode off never pays a fee that no launch can use. */
export function assertLaunchFeePayable(current: Pick<RuntimeConfig, "nftMode">) {
  if (current.nftMode?.enabled !== true || !current.nftMode.vaultFactory) throw new Error(FEE_NFT_MODE_OFF);
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
/** The NFT step's wallet lists (tasks/nft-mode-wallet-picker.md §4): a convenience; the live check stays the authority. */
export function readNftCollections(config: Pick<RuntimeConfig, "mode" | "deploymentChainId">, owner: Address) {
  return chainApi<OwnedCollections>(deploymentChain(config), `/nft-collections?owner=${owner}`);
}
export function readNftTokens(config: Pick<RuntimeConfig, "mode" | "deploymentChainId">, owner: Address, contract: Address) {
  return chainApi<OwnedNfts>(deploymentChain(config), `/nft-tokens?owner=${owner}&contract=${contract}`);
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
export type NftIdentity = Pick<LaunchInput, "name" | "symbol" | "image">;
export type NftPrefill = Partial<NftIdentity>;
/** Only empty fields and values the previous prefill still owns follow the NFT. Missing or reserved values clear an owned field.
 * Image decisions can be made before conversion, but only the pinned result is applied to the draft. */
export function nftPrefill(draft: NftIdentity, nft: { name?: string; image?: string }, previous: NftPrefill = {}): NftPrefill {
  const name = (nft.name ?? "").trim().slice(0, 32), symbol = name.replace(/[^A-Za-z]/g, "").slice(0, 10).toUpperCase();
  const values = { name: reservedLaunchName(name, "") ? "" : name,
    symbol: reservedLaunchName("", symbol) ? "" : symbol, image: nft.image ?? "" };
  const changes: NftPrefill = {};
  for (const field of ["name", "symbol", "image"] as const) {
    const owned = previous[field] !== undefined && draft[field] === previous[field];
    if ((!draft[field].trim() || owned) && (values[field] || owned)) changes[field] = values[field];
  }
  return changes;
}

// ---- the $10 fee, recorded per creator --------------------------------------------------------
// The server spends a fee per creator, so one record per chain and wallet serves every draft of that wallet. It is a recorded send
// (send-record.ts): written right before the wallet receives the request ("sending", with the account's pending nonce), upgraded at the
// hash ("pending"), and "paid" after two confirmations. Only a definite answer removes it: a wallet rejection, a reverted payment, its nonce
// spent by another transaction, a registration that used it, the server's NFT_FEE_USED, or the user's explicit choice.
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
export const FEE_WALLET_CANCELLED = "You cancelled the payment in your wallet. No fee was paid.";
export const FEE_WALLET_REFUSED = "Your wallet refused the payment request, and nothing was sent. You can try again or use another wallet.";
/** Why `attemptAfterSendError` cleared an attempt: the user's own rejection, or the wallet refusing the request unprocessed. */
export function launchFeeClearedNotice(error: unknown) {
  return isUserRejection(error) ? FEE_WALLET_CANCELLED : FEE_WALLET_REFUSED;
}

export const FEE_REVERTED = "The launch fee payment failed on-chain, so no fee was paid. You can pay again.";
export const FEE_CANCELLED = "No fee was paid; the payment was cancelled.";
export const FEE_MAYBE_SENT = "A payment may have been sent. Check your wallet's activity.";
export const FEE_WAITING = "Payment sent, waiting for confirmation. If your wallet shows it pending, speed it up or cancel it there.";
export const FEE_TAKEN = "Another launch fee payment from this wallet was recorded meanwhile, so this one was not sent. Check it here before you pay again.";
export const FEE_UNCONFIRMED = "We can't confirm this payment yet. Check your wallet's activity. If no payment left your wallet, choose \u201cNo payment was sent\u201d.";
export type FeeResolution =
  | { status: "paid"; fee: DraftLaunchFee }
  | { status: "failed"; reason: string } // Definitely no fee: the caller removes the record.
  | { status: "waiting"; record?: LaunchFeeAttempt } // A known payment is still confirming (`record`: the same, now with its seen nonce).
  | { status: "unknown"; reason: string }; // No proof either way: the caller offers "No payment was sent — pay again".
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
/** Decides an attempt from the chain alone (`resolveSentTransaction`, matching exactly this attempt's fee); throws on RPC failure, and the
 * caller asks again later. `hint`: a replacement the wallet reported. */
export async function resolveLaunchFee(client: SendReader, config: FeeConfig, record: LaunchFeeAttempt, hint?: Hex,
  memo: NonceMemo = new Map()): Promise<FeeResolution> {
  const result = await resolveSentTransaction(client, record, (tx) => launchFeeTxMatches(config, record, tx), hint, memo);
  switch (result.status) {
    case "confirmed": return { status: "paid", fee: launchFeeOf(record.asset, result.hash, record.quote) };
    case "reverted": return { status: "failed", reason: FEE_REVERTED };
    case "cancelled": return { status: "failed", reason: FEE_CANCELLED };
    case "unknown": return { status: "unknown", reason: FEE_UNCONFIRMED };
    default: return result;
  }
}
