import { concat, encodeAbiParameters, getAddress, getContractAddress, keccak256, pad, toHex, type Address, type Hex } from "viem";
import manifestJson from "../../contracts/artifacts/nft-vault-deployment.json";

export type NftChainId = 8453 | 4663;
export type NftRef = { chainId: NftChainId; contract: Address; tokenId: string };
/** `/api/nft-status`: what the create form shows about an NFT for a wallet. `name` and `agentId` come only for Muses, and only when read. */
export type NftStatus = { erc721: boolean; owner: Address | null; controls: boolean; alreadyLaunched: boolean; free: boolean; name?: string; agentId?: string };

export const ERC6551_REGISTRY = getAddress("0x000000006551c19487814612e58FE06813775758");
export const TOKENBOUND_V3_PROXY = getAddress("0x55266d75D1a14E4572138116aF39863Ed6596E7F");
export const TOKENBOUND_V3_IMPLEMENTATION = getAddress("0x41C8f39463A868d3A88af00cd0fe7102F30E44eC");
export const DELEGATE_REGISTRY_V2 = getAddress("0x00000000000000447e69651d841bD8D104Bed493");
export const MUSES = { chainId: 4663, contract: getAddress("0x13Ea3072b7215d4C9c2Ec4f498A08c5825129836") } as const;
export const NFT_LAUNCH_RIGHTS = keccak256(toHex("musegod.fun.launch"));
const ZERO_SALT = pad("0x00", { size: 32 });

export function nftKey(nft: NftRef): string {
  return `${nft.chainId}:${nft.contract.toLowerCase()}:${nft.tokenId}`;
}
export function isMuse(nft: NftRef): boolean {
  return nft.chainId === MUSES.chainId && nft.contract.toLowerCase() === MUSES.contract.toLowerCase();
}
/** ERC-6551 v0.3.1 registry address formula for the Tokenbound V3 account (salt 0). */
export function treasuryFor(nft: NftRef): Address {
  const bytecode = concat([
    "0x3d60ad80600a3d3981f3363d3d373d3d3d363d73", TOKENBOUND_V3_PROXY, "0x5af43d82803e903d91602b57fd5bf3",
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
      [ZERO_SALT, BigInt(nft.chainId), nft.contract, BigInt(nft.tokenId)]),
  ]);
  return getContractAddress({ opcode: "CREATE2", from: ERC6551_REGISTRY, salt: ZERO_SALT, bytecode });
}

export type NftVaultChainEntry = { status: "not_deployed" | "deployed_verified"; factory: Address | null; factoryRuntimeHash: Hex | null;
  transactionHash: Hex | null; blockNumber: number | null };
export type NftVaultManifest = { version: 1; vaultInitCodeHash: Hex; chains: Record<"4663" | "8453", NftVaultChainEntry> };
export const NFT_VAULT_MANIFEST = manifestJson as NftVaultManifest;

/** The deployed, verified factory for a chain, or null. Never a guessed address. */
export function vaultFactory(chainId: NftChainId, manifest: NftVaultManifest = NFT_VAULT_MANIFEST): Address | null {
  const entry = manifest.chains[String(chainId) as "4663" | "8453"];
  return entry?.status === "deployed_verified" && entry.factory ? getAddress(entry.factory) : null;
}
export function vaultFor(nft: NftRef, factory: Address, initCodeHash: Hex = NFT_VAULT_MANIFEST.vaultInitCodeHash): Address {
  const salt = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }],
    [BigInt(nft.chainId), nft.contract, BigInt(nft.tokenId)]));
  return getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecodeHash: initCodeHash });
}
