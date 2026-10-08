import test from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { cutoverRecord } from "../scripts/record-engine-cutover";
import { engineLaunchCutover, ENGINE_MANIFEST } from "../server/launch-policy-registry";
import type { RuntimeConfig } from "../src/lib/config";
import { activatedEngineManifest } from "./engine-manifest-fixture";
import recordedManifest from "./fixtures/engine-cutover-manifest.json";

const engine = "0x3333333333333333333333333333333333333333" as Address;
const robinhood: RuntimeConfig = { mode: "robinhood", deploymentChainId: 4663, chainId: 4663, treasury: engine, writesEnabled: false, blockReason: "paused" };
const blockHash = `0x${"ab".repeat(32)}` as Hex;
const engineOnlyAt = 1_899_999_000n;

test("the cutover is recorded only at a finalized block after both the verified activation and the engine-only runtime", () => {
  const manifest = activatedEngineManifest(engine);
  const verified = { fingerprint: manifest.activationVerification.fingerprint as Hex, activatedAtBlock: "94000000" };
  const block = (number: bigint, timestamp = 1_900_000_000n) => ({ number, hash: blockHash, timestamp });
  const cutover = cutoverRecord(manifest, verified, block(95_000_000n), 95_000_010n, engineOnlyAt);
  assert.deepEqual(cutover, { blockNumber: "95000000", blockHash, timestamp: 1_900_000_000, graphFingerprint: verified.fingerprint, activatedAtBlock: "94000000" });
  assert.equal(engineLaunchCutover(robinhood, { ...manifest, engineLaunchCutover: cutover })?.timestamp, 1_900_000_000,
    "the runtime accepts exactly what the recorder writes");
  for (const [label, run, pattern] of [
    ["unfinalized block", () => cutoverRecord(manifest, verified, block(95_000_011n), 95_000_010n, engineOnlyAt), /must be finalized/],
    ["before activation", () => cutoverRecord(manifest, verified, block(93_999_999n), 95_000_010n, engineOnlyAt), /precede the engine's activation/],
    ["before the engine-only runtime", () => cutoverRecord(manifest, verified, block(95_000_000n, engineOnlyAt - 1n), 95_000_010n, engineOnlyAt),
      /precedes the engine-only runtime/],
    ["already recorded", () => cutoverRecord({ ...manifest, engineLaunchCutover: cutover }, verified, block(95_000_000n), 95_000_010n, engineOnlyAt), /already recorded/],
    ["activation not recorded", () => cutoverRecord({ ...manifest, activationVerification: { status: "pending" } }, verified, block(95_000_000n), 95_000_010n, engineOnlyAt), /verified activation first/],
    ["chain proves another graph", () => cutoverRecord(manifest, { ...verified, fingerprint: `0x${"12".repeat(32)}` }, block(95_000_000n), 95_000_010n, engineOnlyAt), /another graph/],
    ["chain proves another activation block", () => cutoverRecord(manifest, { ...verified, activatedAtBlock: "94000001" }, block(95_000_000n), 95_000_010n, engineOnlyAt), /activation block/],
  ] as const) assert.throws(run, pattern, label);
});

test("a manifest with a recorded cutover type-checks as committed JSON, and the committed one is well formed", () => {
  // The build type-checks this file: a cutover written by the recorder must not break it.
  assert.equal(engineLaunchCutover(robinhood, recordedManifest)?.activatedAtBlock, "94000000");
  assert.doesNotThrow(() => engineLaunchCutover(robinhood, ENGINE_MANIFEST), "the committed cutover, if any, names the activation it followed");
});
