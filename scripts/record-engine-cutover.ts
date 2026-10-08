import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, getAddress, http, type Hex } from "viem";
import { robinhood } from "viem/chains";
import { verifyFeeEngine, type BuybackDeployment } from "../server/buyback-engine";
import { loadEnvironment, redact, runtimeFromEnv } from "../server/config";
import { assertCutoverReadiness, type EngineLaunchCutover } from "../server/launch-policy-registry";

// Records the fixed point from which Robinhood launches route platform fees
// through the buyback engine. It only reads the chain; it never signs.
//
// Order: deploy the Robinhood runtime with FEE_ENGINE_ADDRESS first, so it
// issues only engine previews; once the chain has finalized past that deploy,
// record the cutover with --not-before=<that deploy's unix time> and deploy
// the manifest. Every treasury-only preview the earlier runtime issued then
// stays recoverable within the signing window after the cutover.
const path = "contracts/artifacts/buyback-v2-deployment.json";
type Manifest = Parameters<typeof assertCutoverReadiness>[0];

/** The cutover for a finalized block at or after the on-chain verified
 * activation and the engine-only runtime, bound to that activated graph. */
export function cutoverRecord(manifest: Manifest, verified: { fingerprint: Hex; activatedAtBlock: string },
  block: { number: bigint | null; hash: Hex | null; timestamp: bigint }, finalized: bigint, notBefore: bigint): EngineLaunchCutover {
  assert(!manifest.engineLaunchCutover, "An engine launch cutover is already recorded. Changing it moves recovery trust windows; edit it only with a separate review.");
  const recorded = manifest.activationVerification;
  assert.equal(recorded?.status, "verified", "Record the verified activation first (npm run verify:buyback-engine)");
  assert.equal(recorded?.fingerprint?.toLowerCase(), verified.fingerprint.toLowerCase(), "The recorded activation belongs to another graph");
  assert.equal(recorded?.activatedAtBlock, verified.activatedAtBlock, "The recorded activation block differs from the chain");
  assert(block.number !== null && block.hash, "The cutover block is not available");
  assert(block.number <= finalized, "The cutover block must be finalized");
  assert(block.number >= BigInt(verified.activatedAtBlock), "The cutover cannot precede the engine's activation");
  assert(block.timestamp >= notBefore, "The cutover block precedes the engine-only runtime; wait until the chain finalizes past that deploy");
  const cutover = { blockNumber: String(block.number), blockHash: block.hash, timestamp: Number(block.timestamp), graphFingerprint: verified.fingerprint };
  assertCutoverReadiness({ ...manifest, engineLaunchCutover: cutover });
  return cutover;
}

async function save(target: string, value: unknown) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync(); await file.close(); file = undefined;
    await rename(temporary, target);
    const directory = await open(dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

async function main(args = process.argv.slice(2)) {
  const usage = "Usage: record-engine-cutover --not-before=<unix seconds the engine-only runtime went live> [--block=<finalized block>] [--write]";
  assert(args.every((arg) => arg === "--write" || /^--(?:block|not-before)=(?:0|[1-9]\d{0,19})$/.test(arg)), usage);
  const notBefore = args.find((arg) => arg.startsWith("--not-before="));
  assert(notBefore, usage);
  loadEnvironment();
  const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest & BuybackDeployment;
  const client = createPublicClient({ chain: robinhood, transport: http(runtimeFromEnv(4663).rpcUrl, { timeout: 30_000, retryCount: 0 }) });
  assert.equal(await client.getChainId(), 4663, "Recording requires Robinhood mainnet 4663");
  const engine = manifest.contracts.engine.address;
  assert(engine, "The engine is not deployed");
  // Verifies the runtime graph and replays the activation proof on chain.
  const { activation } = await verifyFeeEngine(client, getAddress(engine), manifest);
  const finalized = await client.getBlock({ blockTag: "finalized" });
  assert(finalized.number !== null, "The RPC did not report a finalized block");
  const requested = args.find((arg) => arg.startsWith("--block="));
  const block = await client.getBlock({ blockNumber: requested ? BigInt(requested.slice(8)) : finalized.number });
  const cutover = cutoverRecord(manifest, activation, block, finalized.number, BigInt(notBefore.slice(13)));
  const write = args.includes("--write");
  if (write) await save(path, { ...manifest, engineLaunchCutover: cutover });
  console.log(JSON.stringify({ status: write ? "recorded" : "dry_run", engineLaunchCutover: cutover,
    next: "Commit and deploy this manifest. Treasury-only backups stay recoverable for receipts up to this block time plus the signing window." }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(redact(error instanceof Error ? error.message : String(error))); process.exitCode = 1; }
}
