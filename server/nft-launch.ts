import { keccak256, parseAbi, type Address, type PublicClient } from "viem";
import { ROBINHOOD_STOCKS, sameAddress } from "../src/lib/config";
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

/** The manifest factory when its deployed runtime hash matches; null for a missing, empty or foreign runtime. Throws only on RPC failure. */
export async function verifyVaultFactory(client: Pick<PublicClient, "getCode">, chainId: NftChainId,
  manifest: NftVaultManifest = NFT_VAULT_MANIFEST): Promise<Address | null> {
  const factory = vaultFactory(chainId, manifest);
  const expected = manifest.chains[String(chainId) as "4663" | "8453"]?.factoryRuntimeHash;
  if (!factory || !expected) return null;
  const code = await client.getCode({ address: factory });
  if (!code || code === "0x") return null;
  return keccak256(code).toLowerCase() === expected.toLowerCase() ? factory : null;
}
