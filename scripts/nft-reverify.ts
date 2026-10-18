import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import { loadEnvironment, redact, runtimeFromEnv } from "../server/config";
import { LaunchpadService } from "../server/service";
import { nftRegistrationStatus, settleLaunchFee, type NftRegistrationStatus, type RegistrationFee } from "../server/nft-launch";
import { TokenUniqueConflict } from "../server/store";
import type { StoreBackend } from "../server/supabase-store";
import { isMuse, nftKey } from "../src/lib/nft-mode";
import type { LaunchFee } from "../src/lib/launch-fee";

export type NftReverifyDeps = {
  chainId: 4663 | 8453;
  client: Pick<PublicClient, "readContract">;
  store: Pick<StoreBackend, "token" | "verifiedNftCoin" | "tokenUsingLaunchFee" | "updateNftVerification" | "nftGuardsReady">;
  assertUnusedLaunchFee(fee: LaunchFee, payer: Address, self?: Address): Promise<void>;
};
type Outcome = { line: string; failed?: true };

/** Settles one NFT coin whose registration met an RPC outage or an unconfirmed fee: only a record with `nft` and a status of `unverified`
 * or none is re-checked, at its receipt block, with the registration rules (pair, fee, one coin per NFT, control). A `fee_unconfirmed`
 * coin's claimed fee is checked again and settles the coin once the chain answers definitively. Verified and rejected statuses are
 * final, records without `nft` are never touched, and a still-failing RPC or unconfirmed fee leaves the record as it is. */
export async function reverifyNftCoin(deps: NftReverifyDeps, address: Address): Promise<Outcome> {
  const record = await deps.store.token(address);
  if (!record) return { line: `${address}: no such token` };
  if (!record.nft) return { line: `${address}: not an NFT coin, untouched` };
  const before = record.nftVerification?.status ?? "none";
  if (before !== "unverified" && before !== "none") return { line: `${address}: ${before}, final` };
  const { blockNumber: block, creator } = record;
  if (!block || !/^\d+$/.test(block) || !creator) return { line: `${address}: ${before}, unchanged (no receipt block or creator)` };
  const nft = record.nft, key = nftKey(nft), { launchFee, ...rest } = record;
  const receiptTimestamp = BigInt(Math.floor(record.createdAt / 1000)), nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  // Re-checks a fee claim by registration's rules: a definite mismatch, a used payment or (past 10 minutes) a transaction the chain does
  // not have settles "invalid"; a payment still unconfirmed or unreadable leaves the record as it is.
  const recheck = (claim: LaunchFee) => settleLaunchFee(() => deps.assertUnusedLaunchFee(claim, creator, record.address), receiptTimestamp, nowSeconds);
  // Muse coins launch free and registration never persists a fee on them, so `spent` stays undefined for them.
  let fee: RegistrationFee | undefined, spent: LaunchFee | undefined;
  if (!isMuse(nft)) {
    const claim = before === "unverified" ? record.nftVerification?.feeClaim : launchFee;
    if (before === "unverified" && launchFee) {
      // Registration verified, and so consumed, this fee before the control read failed. Checking it again against a rotated treasury or
      // quote key would un-consume a real payment.
      fee = "paid"; spent = launchFee;
    } else if (claim) {
      // `fee_unconfirmed`: the payment existed but was unconfirmed or unreadable, so it was left unspent with its claim. No status: the
      // record may predate the verified-fee-only rule, so its fee is only a claim until it verifies now.
      const settled = await recheck(claim);
      if (settled === "retry" || settled === "unconfirmed") return { line: `${address}: ${before}, unchanged (launch-fee check unavailable)` };
      fee = settled; spent = settled === "paid" ? claim : undefined;
    } else if (before === "unverified") {
      // An `unverified` coin with neither a spent fee nor a claim: nothing to re-check, and it consumed no payment.
      return { line: `${address}: unverified, unchanged (no launch fee was verified; its payment stays unspent)` };
    } else fee = "invalid";
  }
  const result: NftRegistrationStatus | "retry" = nft.chainId !== deps.chainId ? { status: "rejected", reason: "not_controller", block }
    : await nftRegistrationStatus({ client: deps.client, nft, creator, blockNumber: BigInt(block),
      existing: await deps.store.verifiedNftCoin(key, record.address), receiptTimestamp, nowSeconds, ...(fee ? { fee } : {}) });
  if (result === "retry" || result.status === "unverified") return { line: `${address}: ${before}, unchanged (RPC unavailable)` };
  // A settled status drops the claim; only a verified fee is kept, as the coin's spent `launchFee`.
  try {
    await deps.store.updateNftVerification({ ...rest, ...(spent ? { launchFee: spent } : {}), nftVerification: result });
  } catch (error) {
    if (!(error instanceof TokenUniqueConflict)) throw error;
    // The server registered another coin since the checks above, with this NFT verified or this fee spent, and the database refused the
    // write (both stores, atomically). A conflict for the operator, never a silent second badge or a second use of one payment.
    const conflict = error.kind === "nft_verified" ? key : spent!.txHash.toLowerCase();
    const other = await Promise.resolve().then(() => error.kind === "nft_verified" ? deps.store.verifiedNftCoin(key, record.address)
      : deps.store.tokenUsingLaunchFee(conflict, creator, record.address)).catch(() => null);
    return { line: `CONFLICT ${conflict} ${address} ${other?.address ?? "unknown"}`, failed: true };
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
    // The database's single-use guards are what make a concurrent registration a CONFLICT instead of a second badge or a second spend.
    if (!(await deps.store.nftGuardsReady()))
      throw new Error("The NFT single-use database guards are missing: apply supabase/migrations/20261014120000_nft_single_use_indexes.sql, then run nft:reverify again. Nothing was changed.");
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
