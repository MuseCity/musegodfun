import { decodeFunctionData, encodeFunctionData, erc20Abi, erc721Abi, pad, parseAbi, type Abi, type Address, type EncodeFunctionDataParameters, type Hex,
  type PublicClient } from "viem";
import { robinhood } from "viem/chains";
import { deploymentChain, sameAddress, type RuntimeConfig, type TokenRecord } from "./config";
import { ERC6551_REGISTRY, TOKENBOUND_V3_IMPLEMENTATION, TOKENBOUND_V3_PROXY, isMuse, nftKey, treasuryFor, vaultFor, type NftRef } from "./nft-mode";

const vaultAbi = parseAbi(["function sweep(bytes32[] poolIds, address[] tokens)"]);
const factoryAbi = parseAbi(["function deploy(uint256 homeChainId, address nft, uint256 tokenId) returns (address)"]);
const registryAbi = parseAbi(["function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)"]);
// Tokenbound V3 AccountV3 (0x41C8…44eC), checked on Sourcify 2026-10-14. A lock is capped at 365 days by the account.
const accountAbi = parseAbi(["function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)",
  "function lock(uint256 lockedUntil)", "function initialize(address implementation)", "function lockedUntil() view returns (uint256)",
  "function isLocked() view returns (bool)"]);
type Tx = { to: Address; data: Hex };

export const sweepTx = (vault: Address, poolIds: Hex[], tokens: Address[]): Tx =>
  ({ to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "sweep", args: [poolIds, tokens] }) });
export const deployVaultTx = (factory: Address, nft: NftRef): Tx =>
  ({ to: factory, data: encodeFunctionData({ abi: factoryAbi, functionName: "deploy", args: [BigInt(nft.chainId), nft.contract, BigInt(nft.tokenId)] }) });
export const activateTreasuryTxs = (nft: NftRef): Tx[] => [
  { to: ERC6551_REGISTRY, data: encodeFunctionData({ abi: registryAbi, functionName: "createAccount",
    args: [TOKENBOUND_V3_PROXY, pad("0x00", { size: 32 }), BigInt(nft.chainId), nft.contract, BigInt(nft.tokenId)] }) },
  { to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "initialize", args: [TOKENBOUND_V3_IMPLEMENTATION] }) },
];
/** Treasury `execute(target, value, data, 0)`: a plain call, never a delegatecall. Native ETH travels inside execute, not on the outer call. */
export function withdrawTx(nft: NftRef, token: Address | "native", to: Address, amount: bigint): Tx {
  const call = token === "native" ? { target: to, value: amount, data: "0x" as Hex }
    : { target: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
  return { to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [call.target, call.value, call.data, 0] }) };
}
export const lockTx = (nft: NftRef, until: number): Tx =>
  ({ to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "lock", args: [BigInt(until)] }) });
export const depositTx = (nft: NftRef, token: Address, amount: bigint): Tx =>
  ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [treasuryFor(nft), amount] }) });

/** `data` is exactly `abi`'s canonical encoding of one call (no trailing bytes), or null. */
function exactCall(abi: Abi, data: Hex) {
  try {
    const call = decodeFunctionData({ abi, data });
    const encoded = encodeFunctionData({ abi, functionName: call.functionName, args: call.args } as EncodeFunctionDataParameters);
    return encoded.toLowerCase() === data.toLowerCase() ? { functionName: call.functionName, args: call.args ?? [] } : null;
  } catch { return null; }
}
/** The only NFT-treasury calls the wallet signs (the last check before a signature). Every address is derived here from `nft` and the
 * server-verified factory, never taken from the caller. Allowed, all with an outer value of 0:
 * - factory.deploy(this NFT) to the verified factory, and vault.sweep to this NFT's vault under it;
 * - registry.createAccount(proxy, salt 0, this NFT) and treasury.initialize(implementation);
 * - treasury.lock(until), and treasury.execute as a plain call (operation 0) that withdraws to `account`: native ETH with no calldata, or
 *   an ERC-20 transfer(account, amount) with no ETH. The account itself only lets its owner execute or lock;
 * - an ERC-20 transfer(treasury, amount) to any token (a deposit). */
export function isNftTreasuryTx(config: Pick<RuntimeConfig, "mode" | "deploymentChainId" | "nftMode">, nft: NftRef,
  tx: { to: Address; data: Hex; value: bigint }, account: Address): boolean {
  if (tx.value !== 0n || nft.chainId !== deploymentChain(config)) return false;
  const factory = config.nftMode?.vaultFactory ?? null, treasury = treasuryFor(nft);
  const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();
  if (sameAddress(tx.to, treasury)) {
    if (activateTreasuryTxs(nft).some((step) => sameAddress(step.to, treasury) && same(step.data, tx.data))) return true;
    const call = exactCall(accountAbi, tx.data);
    if (call?.functionName === "lock") return true;
    if (call?.functionName !== "execute") return false;
    const [target, value, data, operation] = call.args as [Address, bigint, Hex, number];
    if (operation !== 0) return false;
    if (value > 0n) return data === "0x" && sameAddress(target, account);
    const transfer = exactCall(erc20Abi, data);
    return transfer?.functionName === "transfer" && sameAddress(transfer.args[0] as Address, account);
  }
  if (sameAddress(tx.to, ERC6551_REGISTRY)) return same(tx.data, activateTreasuryTxs(nft)[0].data);
  if (factory && sameAddress(tx.to, factory)) return same(tx.data, deployVaultTx(factory, nft).data);
  if (factory && sameAddress(tx.to, vaultFor(nft, factory))) return exactCall(vaultAbi, tx.data)?.functionName === "sweep";
  const transfer = exactCall(erc20Abi, tx.data);
  return transfer?.functionName === "transfer" && sameAddress(transfer.args[0] as Address, treasury);
}

type MulticallReader = Pick<PublicClient, "multicall">;
// Canonical Multicall3, the same address on Robinhood Chain and Base.
const MULTICALL3 = robinhood.contracts.multicall3.address;

/** The account's lock, read in one call through the RPC proxy. */
export async function readTreasuryLock(client: MulticallReader, nft: NftRef): Promise<{ lockedUntil: number; locked: boolean }> {
  const treasury = treasuryFor(nft);
  const [until, locked] = await client.multicall({ allowFailure: true, multicallAddress: MULTICALL3, contracts: [
    { address: treasury, abi: accountAbi, functionName: "lockedUntil" }, { address: treasury, abi: accountAbi, functionName: "isLocked" }] });
  if (until?.status !== "success" || locked?.status !== "success") throw new Error("The treasury lock could not be read.");
  return { lockedUntil: Number(until.result), locked: locked.result === true };
}
export const LOCK_PRESET_DAYS = [1, 7, 30] as const;
/** The lock's end, from the latest block's timestamp. */
export const lockTarget = (blockTimestamp: bigint, days: number) => Number(blockTimestamp) + days * 86_400;

export const NFT_OWNER_SCAN_LIMIT = 200;
/** The NFTs `account` holds among the first 200 NFT coins, each with its coins: one `ownerOf` multicall through the RPC proxy.
 * `capped` says coins past the limit were not checked. A failed read (a burned token, a non-ERC-721) counts as not held. */
export async function heldNftCoins(client: MulticallReader, tokens: TokenRecord[], account: Address) {
  const nftCoins = tokens.filter((token) => token.nft), scanned = nftCoins.slice(0, NFT_OWNER_SCAN_LIMIT);
  const byNft = new Map<string, { nft: NftRef; coins: TokenRecord[] }>();
  for (const coin of scanned) {
    const key = nftKey(coin.nft!), entry = byNft.get(key);
    if (entry) entry.coins.push(coin); else byNft.set(key, { nft: coin.nft!, coins: [coin] });
  }
  const entries = [...byNft.values()], capped = nftCoins.length > NFT_OWNER_SCAN_LIMIT;
  if (!entries.length) return { held: [], capped };
  const owners = await client.multicall({ allowFailure: true, multicallAddress: MULTICALL3, contracts: entries.map(({ nft }) =>
    ({ address: nft.contract, abi: erc721Abi, functionName: "ownerOf", args: [BigInt(nft.tokenId)] })) });
  return { held: entries.filter((_, index) => {
    const owner = owners[index];
    return owner?.status === "success" && typeof owner.result === "string" && sameAddress(owner.result, account);
  }), capped };
}

/** The badge an NFT coin shows: "Muse #N", "NFT #N" for another verified collection, or a warning. A rejected coin shows none. */
export function nftBadge(token: Pick<TokenRecord, "nft" | "nftVerification">): string | null {
  if (!token.nft || token.nftVerification?.status === "rejected") return null;
  if (isMuse(token.nft)) return `Muse #${token.nft.tokenId}`;
  return token.nftVerification?.status === "verified" ? `NFT #${token.nft.tokenId}` : "NFT · unverified collection";
}
/** An NFT coin as Explore lists it: bound, not rejected and not hidden. */
export const listedNftCoin = (token: Pick<TokenRecord, "nft" | "nftVerification" | "hidden">) =>
  !!token.nft && token.nftVerification?.status !== "rejected" && !token.hidden;
