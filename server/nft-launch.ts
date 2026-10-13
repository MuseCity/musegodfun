import { createHmac, timingSafeEqual } from "node:crypto";
import { TransactionReceiptNotFoundError, decodeEventLog, erc20Abi, keccak256, parseAbi, type Address, type Block, type Hex, type PublicClient, type Transaction, type TransactionReceipt } from "viem";
import { ROBINHOOD_STOCKS, sameAddress } from "../src/lib/config";
import { LAUNCH_FEE_MIN_BLOCK, LAUNCH_FEE_MINING_GRACE_SECONDS, LAUNCH_FEE_QUOTE_TTL, LAUNCH_FEE_STABLE, type LaunchFee } from "../src/lib/launch-fee";
import { DELEGATE_REGISTRY_V2, NFT_LAUNCH_RIGHTS, NFT_VAULT_MANIFEST, isMuse, vaultFactory, type NftChainId, type NftRef, type NftVaultManifest } from "../src/lib/nft-mode";
import type { LaunchInput } from "../src/lib/validation";

export type NftLaunchCode = "NFT_MODE_DISABLED" | "NFT_CHAIN_UNSUPPORTED" | "NFT_NOT_ERC721" | "NFT_NOT_CONTROLLED"
  | "NFT_ALREADY_LAUNCHED" | "NFT_MUSE_PAIR_REQUIRED" | "NFT_RESERVED_NAME" | "NFT_FEE_REQUIRED" | "NFT_FEE_INVALID"
  | "NFT_FEE_USED" | "NFT_VAULT_UNAVAILABLE";
export class NftLaunchError extends Error {
  constructor(public code: NftLaunchCode, message: string) { super(message); this.name = "NftLaunchError"; }
}
const erc721Abi = parseAbi(["function supportsInterface(bytes4) view returns (bool)", "function ownerOf(uint256) view returns (address)"]);
const delegateAbi = parseAbi(["function checkDelegateForERC721(address to, address from, address contract_, uint256 tokenId, bytes32 rights) view returns (bool)"]);
const RESERVED = /^(?:musegod|muse\s*god)$/i;
const MUSEGOD_TICKER = "MUSEGOD";

/** CPU-only rules. Prepare calls this before any RPC; register never does (the badge rules replace it there). */
export function assertNftDraftRules(draft: LaunchInput, chainId: NftChainId, enabled: boolean): void {
  const normalized = (value: string) => value.replace(/[^a-z0-9]/gi, "");
  if (RESERVED.test(draft.name.trim()) || normalized(draft.name).toUpperCase() === MUSEGOD_TICKER || draft.symbol.toUpperCase() === MUSEGOD_TICKER)
    throw new NftLaunchError("NFT_RESERVED_NAME", "MUSEGOD is reserved for the official token.");
  if (!draft.nft) return;
  if (!enabled) throw new NftLaunchError("NFT_MODE_DISABLED", "NFT launches are not enabled on this network.");
  if (draft.nft.chainId !== chainId) throw new NftLaunchError("NFT_CHAIN_UNSUPPORTED", "This NFT must launch on its own network.");
  if (isMuse(draft.nft)) {
    const musegod = ROBINHOOD_STOCKS.find((asset) => asset.symbol === MUSEGOD_TICKER);
    if (!musegod || !sameAddress(musegod.address, draft.quoteAddress))
      throw new NftLaunchError("NFT_MUSE_PAIR_REQUIRED", "Muse coins must pair with MUSEGOD.");
  }
}

/** Owner, or a delegate.xyz v2 delegate for this token, contract or wallet (rights musegod.fun.launch or unscoped). */
export async function readNftControl(client: Pick<PublicClient, "readContract">, nft: NftRef, account: Address, blockNumber?: bigint):
  Promise<{ erc721: boolean; owner: Address | null; controls: boolean }> {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const erc721 = await client.readContract({ address: nft.contract, abi: erc721Abi, functionName: "supportsInterface", args: ["0x80ac58cd"], ...at })
    .catch(() => false);
  if (!erc721) return { erc721: false, owner: null, controls: false };
  const owner = await client.readContract({ address: nft.contract, abi: erc721Abi, functionName: "ownerOf", args: [BigInt(nft.tokenId)], ...at })
    .catch(() => null) as Address | null;
  if (!owner || owner === "0x0000000000000000000000000000000000000000") return { erc721: true, owner: null, controls: false };
  if (sameAddress(owner, account)) return { erc721: true, owner, controls: true };
  const delegated = await client.readContract({ address: DELEGATE_REGISTRY_V2, abi: delegateAbi, functionName: "checkDelegateForERC721",
    args: [account, owner, nft.contract, BigInt(nft.tokenId), NFT_LAUNCH_RIGHTS], ...at }).catch(() => false);
  return { erc721: true, owner, controls: delegated === true };
}

/** What the chain says about the manifest factory. `final` is false when no runtime code came back (not deployed yet, or a lagging node),
 * because that can change; a match or a non-empty runtime with another hash is final. Throws only on RPC failure. */
export async function inspectVaultFactory(client: Pick<PublicClient, "getCode">, chainId: NftChainId,
  manifest: NftVaultManifest = NFT_VAULT_MANIFEST): Promise<{ factory: Address | null; final: boolean }> {
  const factory = vaultFactory(chainId, manifest);
  const expected = manifest.chains[String(chainId) as "4663" | "8453"]?.factoryRuntimeHash;
  if (!factory || !expected) return { factory: null, final: true };
  const code = await client.getCode({ address: factory });
  if (!code || code === "0x") return { factory: null, final: false };
  return keccak256(code).toLowerCase() === expected.toLowerCase() ? { factory, final: true } : { factory: null, final: true };
}

/** The manifest factory when its deployed runtime hash matches; null for a missing, empty or foreign runtime. Throws only on RPC failure. */
export async function verifyVaultFactory(client: Pick<PublicClient, "getCode">, chainId: NftChainId,
  manifest: NftVaultManifest = NFT_VAULT_MANIFEST): Promise<Address | null> {
  return (await inspectVaultFactory(client, chainId, manifest)).factory;
}

// ---- the $10 launch fee -------------------------------------------------------------------
// An ETH fee is paid against a platform quote. The MAC binds chain, payer, amount and expiry under a domain of its own,
// so it cannot be confused with a plan attestation made by the same key.
const FEE_DOMAIN = "musegod.nft-launch-fee-quote.v1";
type FeeChainId = 8453 | 4663;
export function launchFeeQuoteMac(key: string, chainId: FeeChainId, payer: Address, wei: string, expiresAt: number): Hex {
  return `0x${createHmac("sha256", key).update(`${FEE_DOMAIN}:${chainId}:${payer.toLowerCase()}:${wei}:${expiresAt}`).digest("hex")}`;
}
/** Accepts the current key and retained previous keys. Malformed input is simply unsigned. */
export function verifyLaunchFeeQuoteMac(keys: readonly string[], chainId: FeeChainId, payer: Address, wei: string, expiresAt: number, mac: unknown): boolean {
  if (typeof mac !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(mac)) return false;
  const supplied = Buffer.from(mac.slice(2), "hex");
  return keys.some((key) => timingSafeEqual(Buffer.from(launchFeeQuoteMac(key, chainId, payer, wei, expiresAt).slice(2), "hex"), supplied));
}

// Only the fields read below, so a chain-specific client (extra receipt and block formatters) still fits.
type FeeClient = {
  getTransactionReceipt(args: { hash: Hex }): Promise<Pick<TransactionReceipt, "status" | "transactionHash" | "blockNumber" | "blockHash" | "from" | "logs">>;
  getTransaction(args: { hash: Hex }): Promise<Pick<Transaction, "from" | "to" | "value" | "input">>;
  getBlock(args: { blockNumber: bigint }): Promise<Pick<Block, "hash" | "timestamp">>;
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
};
/** Verifies that `payer` paid the launch fee to `recipient`: an exact stablecoin transfer mined since NFT mode began, or at least the
 * platform-quoted ETH in a plain transfer mined within the quote's window. Single use is the caller's job (`tokenUsingLaunchFee`).
 * Throws NFT_FEE_INVALID. */
export async function verifyLaunchFeePayment(client: FeeClient, args: { fee: LaunchFee; payer: Address; recipient: Address; chainId: FeeChainId; keys: readonly string[] }):
  Promise<{ blockNumber: bigint }> {
  const invalid = (why: string) => new NftLaunchError("NFT_FEE_INVALID", `The launch fee payment is not valid: ${why}.`);
  // A hash that is not mined yet is the payer's to retry; any other failure is the node's and propagates.
  const receipt = await client.getTransactionReceipt({ hash: args.fee.txHash }).catch((error: unknown) => {
    throw error instanceof TransactionReceiptNotFoundError ? invalid("the transaction has not been mined yet") : error;
  });
  if (receipt.status !== "success") throw invalid("the transaction failed");
  if (receipt.transactionHash.toLowerCase() !== args.fee.txHash.toLowerCase()) throw invalid("the receipt belongs to another transaction");
  if ((await client.getBlockNumber({ cacheTime: 0 })) < receipt.blockNumber + 1n) throw invalid("wait for two confirmations");
  if (!sameAddress(receipt.from, args.payer)) throw invalid("it was not sent by this wallet");
  // Both assets need a canonical receipt: its block must still be the chain's block at that height.
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw invalid("the block was reorganized");
  if (args.fee.asset === "stable") {
    const stable = LAUNCH_FEE_STABLE[args.chainId], minBlock = LAUNCH_FEE_MIN_BLOCK[args.chainId];
    if (!stable || minBlock === undefined) throw invalid("no stablecoin fee on this network");
    if (receipt.blockNumber < minBlock) throw invalid("the payment predates NFT launches");
    const paid = receipt.logs.filter((log) => sameAddress(log.address, stable.address)).some((log) => {
      try {
        const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        return event.eventName === "Transfer" && sameAddress(event.args.from, args.payer) && sameAddress(event.args.to, args.recipient) &&
          event.args.value === stable.amount;
      } catch { return false; }
    });
    if (!paid) throw invalid(`expected exactly ${stable.amount} ${stable.symbol} raw units to the operations wallet`);
    return { blockNumber: receipt.blockNumber };
  }
  if (!args.fee.wei || !args.fee.expiresAt || !verifyLaunchFeeQuoteMac(args.keys, args.chainId, args.payer, args.fee.wei, args.fee.expiresAt, args.fee.mac))
    throw invalid("the ETH quote is not platform-signed");
  const tx = await client.getTransaction({ hash: args.fee.txHash });
  if (!sameAddress(tx.from, args.payer) || !tx.to || !sameAddress(tx.to, args.recipient) || tx.value < BigInt(args.fee.wei))
    throw invalid("the ETH amount or recipient is wrong");
  // A plain value transfer only: calldata means a contract call, not a payment.
  if (tx.input !== "0x") throw invalid("the ETH payment must be a plain transfer");
  if (block.timestamp > BigInt(args.fee.expiresAt + LAUNCH_FEE_MINING_GRACE_SECONDS)) throw invalid("the quote expired");
  // The quote was issued LAUNCH_FEE_QUOTE_TTL before it expires; an older payment would settle a later, cheaper price. 120 s allows for clock skew.
  if (block.timestamp < BigInt(args.fee.expiresAt) - BigInt(LAUNCH_FEE_QUOTE_TTL / 1000) - 120n) throw invalid("the payment predates its quote");
  return { blockNumber: receipt.blockNumber };
}
