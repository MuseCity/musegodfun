import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import { loadEnvironment, redact, runtimeFromEnv } from "../server/config";
import { LaunchpadService } from "../server/service";
import { NftLaunchError, nftRegistrationStatus, type NftRegistrationStatus, type RegistrationFee } from "../server/nft-launch";
import type { StoreBackend } from "../server/supabase-store";
import { isMuse, nftKey } from "../src/lib/nft-mode";
import type { LaunchFee } from "../src/lib/launch-fee";

export type NftReverifyDeps = {
  chainId: 4663 | 8453;
  client: Pick<PublicClient, "readContract">;
  store: Pick<StoreBackend, "token" | "verifiedNftCoin" | "updateNftVerification">;
  assertUnusedLaunchFee(fee: LaunchFee, payer: Address, self?: Address): Promise<void>;
};
type Outcome = { line: string; failed?: true };

/** Settles one NFT coin whose registration met an RPC outage: only a record with `nft` and a status of `unverified` or none is
 * re-checked, at its receipt block, with the registration rules (pair, fee, one coin per NFT, control). Verified and rejected
 * statuses are final, records without `nft` are never touched, and a still-failing RPC leaves the record as it is. */
export async function reverifyNftCoin(deps: NftReverifyDeps, address: Address): Promise<Outcome> {
  const record = await deps.store.token(address);
  if (!record) return { line: `${address}: no such token` };
  if (!record.nft) return { line: `${address}: not an NFT coin, untouched` };
  const before = record.nftVerification?.status ?? "none";
  if (before !== "unverified" && before !== "none") return { line: `${address}: ${before}, final` };
  const { blockNumber: block, creator } = record;
  if (!block || !/^\d+$/.test(block) || !creator) return { line: `${address}: ${before}, unchanged (no receipt block or creator)` };
  const nft = record.nft, key = nftKey(nft), { launchFee, ...rest } = record;
  // Muse coins launch free and registration never persists a fee on them, so `keepFee` stays false for them.
  let fee: RegistrationFee | undefined, keepFee = false;
  if (!isMuse(nft)) {
    if (before === "unverified") {
      // An `unverified` coin with a fee: registration verified, and so consumed, it before the control read failed. Checking it again
      // against a rotated treasury or quote key would un-consume a real payment. Without one, the fee could not be confirmed within
      // 10 minutes and was left unspent: a coin that consumed no payment never becomes verified, and is never rejected for it either.
      if (!launchFee) return { line: `${address}: unverified, unchanged (no launch fee was verified; its payment stays unspent)` };
      keepFee = true; fee = "paid";
    } else {
      // No status: the record may predate the verified-fee-only rule, so its fee is only a claim until it verifies now.
      fee = "invalid";
      if (launchFee) {
        try { await deps.assertUnusedLaunchFee(launchFee, creator, record.address); fee = "paid"; keepFee = true; }
        catch (error) { if (!(error instanceof NftLaunchError) || error.retryable) return { line: `${address}: ${before}, unchanged (launch-fee check unavailable)` }; }
      }
    }
  }
  const result: NftRegistrationStatus | "retry" = nft.chainId !== deps.chainId ? { status: "rejected", reason: "not_controller", block }
    : await nftRegistrationStatus({ client: deps.client, nft, creator, blockNumber: BigInt(block),
      existing: await deps.store.verifiedNftCoin(key, record.address), quoteAddress: record.quoteAddress,
      receiptTimestamp: BigInt(Math.floor(record.createdAt / 1000)), nowSeconds: BigInt(Math.floor(Date.now() / 1000)), ...(fee ? { fee } : {}) });
  if (result === "retry" || result.status === "unverified") return { line: `${address}: ${before}, unchanged (RPC unavailable)` };
  await deps.store.updateNftVerification({ ...rest, ...(keepFee ? { launchFee } : {}), nftVerification: result });
  // The server may have verified another coin for this NFT since the check above. SQLite refuses such a write atomically; Supabase
  // cannot, so a second verified coin may now exist. Either way it is a conflict for the operator, never a silent second badge.
  if (result.status === "verified") {
    const other = await deps.store.verifiedNftCoin(key, record.address);
    if (other) return { line: `CONFLICT ${key} ${address} ${other.address}`, failed: true };
  }
  const after = (await deps.store.token(address))?.nftVerification;
  const line = `${address}: ${before} -> ${after?.status ?? "none"}${after?.reason ? ` (${after.reason})` : ""}`;
  return after?.status === result.status && after.reason === result.reason ? { line }
    : { line: `${line} (not written: the record changed meanwhile; run again)`, failed: true };
}

export async function nftReverifyCommand(args: string[], deps?: NftReverifyDeps): Promise<{ lines: string[]; failed: boolean }> {
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
    let failed = false;
    for (const address of addresses) {
      const outcome = await reverifyNftCoin(deps, getAddress(address));
      lines.push(outcome.line); failed ||= outcome.failed === true;
    }
    return { lines, failed };
  } finally { await service?.store.close(); }
}

const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
const runner = process.argv[2] && pathToFileURL(resolve(process.argv[2])).href === import.meta.url && process.argv[1]?.endsWith("run.ts");
if (direct || runner) {
  loadEnvironment();
  try {
    const { lines, failed } = await nftReverifyCommand(process.argv.slice(direct ? 2 : 3));
    for (const line of lines) (line.startsWith("CONFLICT") ? console.error : console.log)(line);
    if (failed) process.exitCode = 1;
  } catch (error) { console.error(redact(error)); process.exitCode = 1; }
}
