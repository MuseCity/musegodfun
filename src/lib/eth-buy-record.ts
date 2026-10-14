import type { Address, Hex } from "viem";
import { z } from "zod";
import { deploymentChain, sameAddress, type RuntimeConfig } from "./config";
import { resolveSentTransaction, type NonceMemo, type NonceTransaction, type SendReader } from "./send-record";
import { addressSchema, hashSchema } from "./validation";

// ---- an ETH buy through LI.FI, recorded per chain and wallet -------------------------------------------------------------------
// A recorded send (send-record.ts), one per chain and wallet: written right before the wallet receives the LI.FI transaction ("sending",
// with the account's pending nonce and the head block), upgraded at the hash ("pending"). Only a definite answer removes it: the wallet's
// canonical successful receipt (the buy is shown), a rejection or unprocessed refusal before any hash, the chain (exactly this transaction
// confirmed or failed, or another transaction spent its nonce), or the user's explicit "No payment was sent". While it exists, this wallet
// gets no ETH quote and sends no ETH buy on this network, in any tab.

/** What the recorded transaction delivers: the coin itself, or the pair asset (the first of two steps). `coin`: the coin being bought. */
export type EthBuyTarget = { kind: "coin" | "conversion"; token: Address; symbol: string; decimals: number; coin: string };
type EthBuyFields = { from: Address; at: number; quoteId: string; tx: { to: Address; data: Hex; value: string }; target: EthBuyTarget;
  nonce?: number; block?: string };
export type EthBuyRecord =
  | (EthBuyFields & { state: "sending"; nonce: number; block: string })
  | (EthBuyFields & { state: "pending"; txHash: Hex; nonceSeen?: true });

const lowerHex = (pattern: RegExp) => z.string().regex(pattern).transform((value) => value.toLowerCase() as Hex);
const nonceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), blockSchema = z.string().regex(/^\d{1,20}$/);
const fields = { from: addressSchema, at: z.number().int().nonnegative(), quoteId: z.string().min(1).max(200),
  tx: z.object({ to: addressSchema, data: lowerHex(/^0x(?:[0-9a-fA-F]{2})*$/), value: z.string().regex(/^\d{1,78}$/) }).strict(),
  target: z.object({ kind: z.enum(["coin", "conversion"]), token: addressSchema, symbol: z.string().min(1).max(40), decimals: z.number().int().min(0).max(36),
    coin: z.string().min(1).max(40) }).strict(),
  nonce: nonceSchema.optional(), block: blockSchema.optional() };
const recordSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("sending"), ...fields, nonce: nonceSchema, block: blockSchema }).strict(),
  z.object({ state: z.literal("pending"), ...fields, txHash: hashSchema.transform((hash) => hash.toLowerCase() as Hex), nonceSeen: z.literal(true).optional() }).strict(),
]);
export function parseEthBuyRecord(raw: string | null): EthBuyRecord | null {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw || "null"));
    return parsed.success ? parsed.data as EthBuyRecord : null;
  } catch { return null; }
}
export function ethBuyStorageKey(config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId">, account: Address) {
  return `musegod.eth-buy.v1.${config.chainId}.${deploymentChain(config)}.${account.toLowerCase()}`;
}
/** The intent id of the cross-tab lock (launch-intent.ts) every ETH buy of one wallet and network takes around its record check and wallet
 * request, so two tabs never send two buys. */
export const ETH_BUY_LOCK = "eth-buy-lifi";
/** Exactly the recorded transaction: its sender, target, calldata and ETH. */
export function ethBuyTxMatches(record: Pick<EthBuyRecord, "from" | "tx">, tx: NonceTransaction): boolean {
  return sameAddress(tx.from, record.from) && !!tx.to && sameAddress(tx.to, record.tx.to) && tx.input.toLowerCase() === record.tx.data.toLowerCase() &&
    tx.value === BigInt(record.tx.value);
}

export const ETH_BUY_UNRESOLVED = "An earlier ETH buy from this wallet may have been sent and is not settled yet. Check it here before you buy with ETH again.";
export const ETH_BUY_MAYBE_SENT = "Your wallet may have sent this ETH buy. Check your wallet's activity; this page also checks the chain.";
export const ETH_BUY_WAITING = "Your ETH buy was sent and is waiting for confirmation.";
export const ETH_BUY_UNCONFIRMED = "We can't confirm this ETH buy yet. Check your wallet's activity. If no ETH left your wallet for it, choose “No payment was sent”.";
export const ETH_BUY_REVERTED = "The ETH buy failed on-chain, so it spent no ETH apart from network gas. You can buy again.";
export const ETH_BUY_CANCELLED = "The ETH buy was replaced or cancelled in your wallet, so it spent no ETH. You can buy again.";
export type EthBuyResolution =
  | { status: "bought"; hash: Hex } // Exactly this transaction confirmed: the caller shows it and removes the record.
  | { status: "failed"; reason: string } // Definitely not bought: the caller removes the record.
  | { status: "waiting"; record?: EthBuyRecord }
  | { status: "unknown"; reason: string }; // No proof either way: the caller offers "No payment was sent".
/** Decides a recorded ETH buy from the chain alone (`resolveSentTransaction`); throws on RPC failure, and the caller asks again later. */
export async function resolveEthBuy(client: SendReader, record: EthBuyRecord, hint?: Hex, memo: NonceMemo = new Map()): Promise<EthBuyResolution> {
  const result = await resolveSentTransaction(client, record, (tx) => ethBuyTxMatches(record, tx), hint, memo);
  switch (result.status) {
    case "confirmed": return { status: "bought", hash: result.hash };
    case "reverted": return { status: "failed", reason: ETH_BUY_REVERTED };
    case "cancelled": return { status: "failed", reason: ETH_BUY_CANCELLED };
    case "unknown": return { status: "unknown", reason: ETH_BUY_UNCONFIRMED };
    default: return result;
  }
}
