import { encodeFunctionData, erc20Abi, type Address, type Hex, type PublicClient } from "viem";
import { deploymentChain, sameAddress, type RuntimeConfig } from "./config";
import { LAUNCH_FEE_STABLE } from "./launch-fee";
import { isMuse, type NftRef, type NftStatus } from "./nft-mode";
import { chainApi } from "./api";
import { launchIntentStorageKey } from "./launch-intent";
import { launchFeeSchema, type LaunchInput } from "./validation";

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
/** Exactly a launch-fee payment: the stablecoin transfer above, or a plain ETH transfer to the treasury. The wallet signs nothing near it. */
export function isLaunchFeeTx(config: FeeConfig, tx: { to: Address; data: Hex; value: bigint }): boolean {
  try {
    const stable = launchFeeStableTx(config);
    if (sameAddress(tx.to, stable.to) && tx.data.toLowerCase() === stable.data.toLowerCase() && tx.value === 0n) return true;
  } catch { /* No stablecoin fee on this network. */ }
  return !!config.treasury && sameAddress(tx.to, config.treasury) && tx.data === "0x" && tx.value > 0n;
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
/** Why the review must wait, or null. In NFT mode a coin never launches without its confirmed NFT, so it can never fall back to a normal coin. */
export function nftReviewBlocker(nftMode: boolean, draft: Pick<LaunchInput, "nft" | "launchFee">, stepStatus: string): string | null {
  if (!nftMode) return null;
  if (!draft.nft) return stepStatus.trim() || "Check the NFT before you review the launch.";
  if (!isMuse(draft.nft) && !draft.launchFee) return "Pay the $10 launch fee for this NFT first.";
  return null;
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

// ---- the paid fee, persisted per intent ------------------------------------------------------
/** A paid fee as the draft carries it (the launch schema's shape). */
export type DraftLaunchFee = NonNullable<LaunchInput["launchFee"]>;
/** A sent fee is saved with `pending` before it confirms, so a reload never loses its hash or offers a second payment. */
export type LaunchFeeRecord = DraftLaunchFee & { pending?: true };
/** Under the intent's "payment" kind, next to (never replacing) the first-buy conversion record. */
export function launchFeeStorageKey(config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId">, account: Address, intentId: string) {
  return `${launchIntentStorageKey(config, account, intentId, "payment")}.launch-fee`;
}
export function parseLaunchFeeRecord(raw: string | null): LaunchFeeRecord | null {
  try {
    const value = JSON.parse(raw || "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { pending, ...fee } = value;
    if (pending !== undefined && pending !== true) return null;
    const parsed = launchFeeSchema.safeParse(fee);
    return parsed.success ? { ...parsed.data, ...(pending ? { pending: true as const } : {}) } : null;
  } catch { return null; }
}
/** Drops the saved fee once it is spent: a registered coin consumed it, or prepare reported it used. */
export function forgetLaunchFee(key: string, txHash: Hex) {
  try {
    if (parseLaunchFeeRecord(localStorage.getItem(key))?.txHash === txHash.toLowerCase()) localStorage.removeItem(key);
  } catch { /* Storage is unavailable; the server refuses a used fee anyway. */ }
}
export function launchFeeOf(asset: DraftLaunchFee["asset"], txHash: Hex, quote?: LaunchFeeQuote): DraftLaunchFee {
  return asset === "native" && quote ? { asset, txHash: txHash.toLowerCase() as Hex, wei: quote.wei, expiresAt: quote.expiresAt, mac: quote.mac }
    : { asset: "stable", txHash: txHash.toLowerCase() as Hex };
}
/** Waits for two confirmations. A repriced payment keeps its new hash; a reverted, cancelled or replaced one is refused.
 * A timeout or RPC failure throws, so the caller keeps the pending record. */
export async function settleLaunchFee(client: Pick<PublicClient, "waitForTransactionReceipt">, record: LaunchFeeRecord, timeout = 120_000):
  Promise<{ status: "paid"; fee: DraftLaunchFee } | { status: "failed"; reason: string }> {
  let replacement: string | undefined;
  const receipt = await client.waitForTransactionReceipt({ hash: record.txHash, confirmations: 2, timeout,
    onReplaced: (replaced) => { replacement = replaced.reason; } });
  if (replacement && replacement !== "repriced")
    return { status: "failed", reason: "The launch fee payment was cancelled or replaced in your wallet, so no fee was paid. You can pay again." };
  if (receipt.status !== "success")
    return { status: "failed", reason: "The launch fee payment failed on-chain, so no fee was paid. You can pay again." };
  const { pending: _pending, ...fee } = record;
  return { status: "paid", fee: { ...fee, txHash: receipt.transactionHash.toLowerCase() as Hex } };
}
