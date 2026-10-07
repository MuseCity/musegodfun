import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import type { RuntimeConfig } from "../src/lib/config";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import { assertTrustedLaunchPolicy, trustedLaunchPolicies } from "../server/launch-policy-registry";

const configured = "0x2222222222222222222222222222222222222222" as Address;
const operations = "0xc4F87C3715374445C4657aa14c47CBB339b59d1A" as Address;
const engineV1 = "0x2f1FD06e3b6Dd81123629d08a74A6279Ea03797f" as Address;
const unknown = "0x9999999999999999999999999999999999999999" as Address;
const robinhood = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig =>
  ({ mode: "robinhood", deploymentChainId: 4663, chainId: 4663, treasury: configured, writesEnabled: false, blockReason: "paused", ...overrides });
const engineBlock = 81_459_143n;

test("recovery trusts the configured treasury and committed Robinhood deployment routing only", () => {
  const config = robinhood();
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: configured }, config, 10n));
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: operations }, config, 10n),
    "the committed operations treasury stays recoverable after PLATFORM_TREASURY changes");
  for (const plan of [
    { feePolicy: FEE_POLICY, feeTreasury: unknown },
    { feePolicy: FEE_POLICY },
    { feePolicy: FEE_POLICY, feeTreasury: configured, feeEngine: engineV1 },
    { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations },
    { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: unknown },
    { feePolicy: ENGINE_FEE_POLICY, feeTreasury: unknown, feeEngine: engineV1 },
    { feePolicy: "musegod-80-v1" as const, feeTreasury: configured },
  ] as const) assert.throws(() => assertTrustedLaunchPolicy(plan, config, engineBlock + 1n), /platform-approved/, JSON.stringify(plan));
});

test("verified engines are trusted only from their creation block, regardless of signing state", () => {
  for (const config of [robinhood(), robinhood({ treasury: null, writesEnabled: false, signingPaused: true })]) {
    const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engineV1 };
    assert.doesNotThrow(() => assertTrustedLaunchPolicy(plan, config, engineBlock));
    assert.throws(() => assertTrustedLaunchPolicy(plan, config, engineBlock - 1n), /platform-approved/);
  }
  // A pending manifest with no address contributes no engine.
  assert(!trustedLaunchPolicies(robinhood()).some((policy) => policy.feeEngine === null && policy.feePolicy === ENGINE_FEE_POLICY));
  assert.equal(trustedLaunchPolicies(robinhood()).filter((policy) => policy.feePolicy === ENGINE_FEE_POLICY).length, 1);
});

test("an operator-configured engine is trusted with the configured treasury, and Base ignores Robinhood manifests", () => {
  const config = robinhood({ feeEngine: unknown });
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: ENGINE_FEE_POLICY, feeTreasury: configured, feeEngine: unknown }, config, 1n));
  assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: unknown }, config, 1n));
  const baseConfig: RuntimeConfig = { mode: "base", deploymentChainId: 8453, chainId: 8453, treasury: configured, writesEnabled: false, blockReason: null };
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: configured }, baseConfig, 1n));
  assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: operations }, baseConfig, 1n));
  assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engineV1 }, baseConfig, engineBlock));
  assert.deepEqual(trustedLaunchPolicies({ ...baseConfig, treasury: null }), [], "no configured treasury trusts nothing on Base");
});
