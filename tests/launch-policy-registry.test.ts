import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import type { RuntimeConfig } from "../src/lib/config";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import { assertTrustedLaunchPolicy, ENGINE_MANIFEST, trustedLaunchPolicies } from "../server/launch-policy-registry";

const configured = "0x2222222222222222222222222222222222222222" as Address;
const operations = "0xc4F87C3715374445C4657aa14c47CBB339b59d1A" as Address;
const neverActivated = "0x2f1FD06e3b6Dd81123629d08a74A6279Ea03797f" as Address;
const engine = "0x3333333333333333333333333333333333333333" as Address;
const unknown = "0x9999999999999999999999999999999999999999" as Address;
const robinhood = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig =>
  ({ mode: "robinhood", deploymentChainId: 4663, chainId: 4663, treasury: configured, writesEnabled: false, blockReason: "paused", ...overrides });
const deployed = (status = "deployed_verified") =>
  ({ ...ENGINE_MANIFEST, status, contracts: { engine: { address: engine, blockNumber: "90000000" } } });

test("recovery trusts the configured treasury and committed Robinhood deployment routing only", () => {
  const config = robinhood();
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: configured }, config, 10n));
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: operations }, config, 10n),
    "the committed operations treasury stays recoverable after PLATFORM_TREASURY changes");
  for (const plan of [
    { feePolicy: FEE_POLICY, feeTreasury: unknown },
    { feePolicy: FEE_POLICY },
    { feePolicy: FEE_POLICY, feeTreasury: configured, feeEngine: engine },
    { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations },
    { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: unknown },
    { feePolicy: "musegod-80-v1" as const, feeTreasury: configured },
  ] as const) assert.throws(() => assertTrustedLaunchPolicy(plan, config, 10n ** 9n), /platform-approved/, JSON.stringify(plan));
});

test("no engine is trusted before the V2 deployment, and the never-activated earlier engine never is", () => {
  assert.equal(ENGINE_MANIFEST.status, "pending_deployment");
  assert(!trustedLaunchPolicies(robinhood()).some((policy) => policy.feePolicy === ENGINE_FEE_POLICY));
  const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: neverActivated };
  for (const config of [robinhood(), robinhood({ treasury: operations, feeEngine: neverActivated }), robinhood({ treasury: null, signingPaused: true })])
    for (const block of [81_459_143n, 10n ** 12n]) assert.throws(() => assertTrustedLaunchPolicy(plan, config, block), /platform-approved/);
});

test("the deployed V2 engine is trusted from its creation block, regardless of signing state", () => {
  const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engine };
  for (const config of [robinhood(), robinhood({ treasury: null, signingPaused: true })]) {
    const policies = trustedLaunchPolicies(config, deployed());
    assert.doesNotThrow(() => assertTrustedLaunchPolicy(plan, config, 90_000_000n, policies));
    assert.throws(() => assertTrustedLaunchPolicy(plan, config, 89_999_999n, policies), /platform-approved/);
    assert.throws(() => assertTrustedLaunchPolicy({ ...plan, feeTreasury: configured }, config, 90_000_000n, policies), /platform-approved/,
      "the engine is trusted only with its own operations treasury");
  }
  assert.equal(trustedLaunchPolicies(robinhood(), deployed("partially_deployed")).filter((policy) => policy.feePolicy === ENGINE_FEE_POLICY).length, 0);
});

test("an operator-configured engine is never trusted, even on a local fork, and Base ignores the Robinhood manifest", () => {
  for (const configuredEngine of [unknown, neverActivated])
    for (const config of [robinhood({ feeEngine: configuredEngine }), robinhood({ mode: "fork", chainId: 31337, feeEngine: configuredEngine })]) {
      const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: configured, feeEngine: configuredEngine };
      for (const block of [1n, 10n ** 12n]) assert.throws(() => assertTrustedLaunchPolicy(plan, config, block), /platform-approved/,
        `${config.mode} ${configuredEngine}: engines come only from the committed manifest`);
      assert(!trustedLaunchPolicies(config).some((policy) => policy.feePolicy === ENGINE_FEE_POLICY));
    }
  const baseConfig: RuntimeConfig = { mode: "base", deploymentChainId: 8453, chainId: 8453, treasury: configured, writesEnabled: false, blockReason: null };
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: configured }, baseConfig, 1n));
  assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: operations }, baseConfig, 1n));
  assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engine }, baseConfig, 10n ** 9n,
    trustedLaunchPolicies(baseConfig, deployed())));
  assert.deepEqual(trustedLaunchPolicies({ ...baseConfig, treasury: null }), [], "no configured treasury trusts nothing on Base");
});

test("after V2 activation, treasury-only routing is trusted only for launches created before the activation block", () => {
  const activated = { ...deployed(), activationVerification: { status: "verified", activatedAtBlock: "95000000" } };
  for (const config of [robinhood(), robinhood({ treasury: operations })]) {
    const policies = trustedLaunchPolicies(config, activated);
    for (const treasury of [config.treasury!, operations]) {
      assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: treasury }, config, 94_999_999n, policies));
      assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: treasury }, config, 95_000_000n, policies), /platform-approved/,
        "a no-engine launch created after activation would bypass the buyback");
    }
    assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engine }, config, 95_000_000n, policies));
  }
  const pending = { ...deployed(), activationVerification: { status: "pending" } };
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: operations }, robinhood(), 10n ** 12n, trustedLaunchPolicies(robinhood(), pending)),
    "an unverified activation does not cut off treasury-only launches");
  const baseConfig: RuntimeConfig = { mode: "base", deploymentChainId: 8453, chainId: 8453, treasury: configured, writesEnabled: false, blockReason: null };
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: configured }, baseConfig, 10n ** 12n, trustedLaunchPolicies(baseConfig, activated)),
    "Base has no engine and keeps treasury routing");
});
