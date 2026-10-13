import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import { loadEnvironment, redact, runtimeFromEnv } from "../server/config";
import { LaunchpadService } from "../server/service";
import { NftLaunchError, nftRegistrationStatus, type NftRegistrationStatus } from "../server/nft-launch";
import type { StoreBackend } from "../server/supabase-store";
import { isMuse, nftKey } from "../src/lib/nft-mode";
import type { LaunchFee } from "../src/lib/launch-fee";

export type NftReverifyDeps = {
  chainId: 4663 | 8453;
  client: Pick<PublicClient, "readContract">;
  store: Pick<StoreBackend, "token" | "verifiedNftCoin" | "updateNftVerification">;
  assertUnusedLaunchFee(fee: LaunchFee, payer: Address, self?: Address): Promise<void>;
};

/** Settles one NFT coin whose registration met an RPC outage: only a record with `nft` and a status of `unverified` or none is
 * re-checked, at its receipt block, with the registration rules (pair, fee, one coin per NFT, control). Verified and rejected
 * statuses are final, records without `nft` are never touched, and a still-failing RPC leaves the record as it is. */
export async function reverifyNftCoin(deps: NftReverifyDeps, address: Address): Promise<string> {
  const record = await deps.store.token(address);
  if (!record) return `${address}: no such token`;
  if (!record.nft) return `${address}: not an NFT coin, untouched`;
  const before = record.nftVerification?.status ?? "none";
  if (before !== "unverified" && before !== "none") return `${address}: ${before}, final`;
  const { blockNumber: block, creator } = record;
  if (!block || !/^\d+$/.test(block) || !creator) return `${address}: ${before}, unchanged (no receipt block or creator)`;
  const nft = record.nft;
  let fee: { ok: boolean } | undefined;
  if (!isMuse(nft)) {
    // Registration persists only a verified fee, but a record with no status may predate that rule: check the payment again.
    fee = { ok: false };
    if (record.launchFee) {
      try { await deps.assertUnusedLaunchFee(record.launchFee, creator, record.address); fee = { ok: true }; }
      catch (error) { if (!(error instanceof NftLaunchError)) return `${address}: ${before}, unchanged (launch-fee check unavailable)`; }
    }
  }
  const result: NftRegistrationStatus | "retry" = nft.chainId !== deps.chainId ? { status: "rejected", reason: "not_controller", block }
    : await nftRegistrationStatus({ client: deps.client, nft, creator, blockNumber: BigInt(block),
      existing: await deps.store.verifiedNftCoin(nftKey(nft), record.address), quoteAddress: record.quoteAddress,
      receiptTimestamp: BigInt(Math.floor(record.createdAt / 1000)), nowSeconds: BigInt(Math.floor(Date.now() / 1000)), ...(fee ? { fee } : {}) });
  if (result === "retry" || result.status === "unverified") return `${address}: ${before}, unchanged (RPC unavailable)`;
  // A fee that did not verify is not this coin's to keep.
  const { launchFee, ...rest } = record;
  await deps.store.updateNftVerification({ ...rest, ...(launchFee && fee?.ok !== false ? { launchFee } : {}), nftVerification: result });
  const after = (await deps.store.token(address))?.nftVerification;
  return `${address}: ${before} -> ${after?.status ?? "none"}${after?.reason ? ` (${after.reason})` : ""}`;
}

export async function nftReverifyCommand(args: string[], deps?: NftReverifyDeps): Promise<string[]> {
  const [network, ...addresses] = args;
  if (!["4663", "8453"].includes(network) || !addresses.length || addresses.some((address) => !isAddress(address, { strict: false })))
    throw new Error("Usage: npm run nft:reverify -- 4663|8453 <token-address> [token-address ...]");
  const chainId = Number(network) as 4663 | 8453;
  let service: LaunchpadService | undefined;
  if (!deps) {
    const owned = service = new LaunchpadService(runtimeFromEnv(chainId));
    await owned.assertNetwork();
    deps = { chainId, client: owned.client, store: owned.store, assertUnusedLaunchFee: (fee, payer, self) => owned.assertUnusedLaunchFee(fee, payer, self) };
  }
  try {
    const lines: string[] = [];
    for (const address of addresses) lines.push(await reverifyNftCoin(deps, getAddress(address)));
    return lines;
  } finally { await service?.store.close(); }
}

const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
const runner = process.argv[2] && pathToFileURL(resolve(process.argv[2])).href === import.meta.url && process.argv[1]?.endsWith("run.ts");
if (direct || runner) {
  loadEnvironment();
  try { for (const line of await nftReverifyCommand(process.argv.slice(direct ? 2 : 3))) console.log(line); }
  catch (error) { console.error(redact(error)); process.exitCode = 1; }
}
