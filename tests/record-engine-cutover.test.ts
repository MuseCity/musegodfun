import test from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { cutoverRecord } from "../scripts/record-engine-cutover";
import { engineLaunchCutover } from "../server/launch-policy-registry";
import type { RuntimeConfig } from "../src/lib/config";
import { activatedEngineManifest } from "./engine-manifest-fixture";

const engine = "0x3333333333333333333333333333333333333333" as Address;
const robinhood: RuntimeConfig = { mode: "robinhood", deploymentChainId: 4663, chainId: 4663, treasury: engine, writesEnabled: false, blockReason: "paused" };
const blockHash = `0x${"ab".repeat(32)}` as Hex;

test("the cutover is recorded only at a finalized block after the on-chain verified activation, bound to that graph", () => {
  const manifest = activatedEngineManifest(engine);
  const verified = { fingerprint: manifest.activationVerification.fingerprint as Hex, activatedAtBlock: "94000000" };
  const block = (number: bigint) => ({ number, hash: blockHash, timestamp: 1_900_000_000n });
  const cutover = cutoverRecord(manifest, verified, block(95_000_000n), 95_000_010n);
  assert.deepEqual(cutover, { blockNumber: "95000000", blockHash, timestamp: 1_900_000_000, graphFingerprint: verified.fingerprint });
  assert.equal(engineLaunchCutover(robinhood, { ...manifest, engineLaunchCutover: cutover })?.timestamp, 1_900_000_000,
    "the runtime accepts exactly what the recorder writes");
  for (const [label, run, pattern] of [
    ["unfinalized block", () => cutoverRecord(manifest, verified, block(95_000_011n), 95_000_010n), /must be finalized/],
    ["before activation", () => cutoverRecord(manifest, verified, block(93_999_999n), 95_000_010n), /precede the engine's activation/],
    ["already recorded", () => cutoverRecord({ ...manifest, engineLaunchCutover: cutover }, verified, block(95_000_000n), 95_000_010n), /already recorded/],
    ["activation not recorded", () => cutoverRecord({ ...manifest, activationVerification: { status: "pending" } }, verified, block(95_000_000n), 95_000_010n), /verified activation first/],
    ["chain proves another graph", () => cutoverRecord(manifest, { ...verified, fingerprint: `0x${"12".repeat(32)}` }, block(95_000_000n), 95_000_010n), /another graph/],
    ["chain proves another activation block", () => cutoverRecord(manifest, { ...verified, activatedAtBlock: "94000001" }, block(95_000_000n), 95_000_010n), /activation block/],
  ] as const) assert.throws(run, pattern, label);
});
