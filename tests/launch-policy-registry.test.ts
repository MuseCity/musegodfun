import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import type { RuntimeConfig } from "../src/lib/config";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import { assertTrustedLaunchPolicy, engineLaunchCutover, ENGINE_MANIFEST, trustedLaunchPolicies } from "../server/launch-policy-registry";
import { planAttestation, verifyPlanAttestation } from "../server/plan-attestation";
import { redact, runtimeFromEnv } from "../server/config";

const configured = "0x2222222222222222222222222222222222222222" as Address;
const operations = "0xc4F87C3715374445C4657aa14c47CBB339b59d1A" as Address;
const neverActivated = "0x2f1FD06e3b6Dd81123629d08a74A6279Ea03797f" as Address;
const engine = "0x3333333333333333333333333333333333333333" as Address;
const unknown = "0x9999999999999999999999999999999999999999" as Address;
const at = (blockNumber: bigint, timestamp = 0n) => ({ blockNumber, timestamp });
const robinhood = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig =>
  ({ mode: "robinhood", deploymentChainId: 4663, chainId: 4663, treasury: configured, writesEnabled: false, blockReason: "paused", ...overrides });
const deployed = (status = "deployed_verified") =>
  ({ ...ENGINE_MANIFEST, status, contracts: { engine: { address: engine, blockNumber: "90000000" } } });

test("recovery trusts the configured treasury and committed Robinhood deployment routing only", () => {
  const config = robinhood();
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: configured }, config, at(10n)));
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: operations }, config, at(10n)),
    "the committed operations treasury stays recoverable after PLATFORM_TREASURY changes");
  for (const plan of [
    { feePolicy: FEE_POLICY, feeTreasury: unknown },
    { feePolicy: FEE_POLICY },
    { feePolicy: FEE_POLICY, feeTreasury: configured, feeEngine: engine },
    { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations },
    { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: unknown },
    { feePolicy: "musegod-80-v1" as const, feeTreasury: configured },
  ] as const) assert.throws(() => assertTrustedLaunchPolicy(plan, config, at(10n ** 9n)), /platform-approved/, JSON.stringify(plan));
});

test("no engine is trusted before the V2 deployment, and the never-activated earlier engine never is", () => {
  assert.equal(ENGINE_MANIFEST.status, "pending_deployment");
  assert(!trustedLaunchPolicies(robinhood()).some((policy) => policy.feePolicy === ENGINE_FEE_POLICY));
  const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: neverActivated };
  for (const config of [robinhood(), robinhood({ treasury: operations, feeEngine: neverActivated }), robinhood({ treasury: null, signingPaused: true })])
    for (const block of [81_459_143n, 10n ** 12n]) assert.throws(() => assertTrustedLaunchPolicy(plan, config, at(block)), /platform-approved/);
});

test("the deployed V2 engine is trusted from its creation block, regardless of signing state", () => {
  const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engine };
  for (const config of [robinhood(), robinhood({ treasury: null, signingPaused: true })]) {
    const policies = trustedLaunchPolicies(config, deployed());
    assert.doesNotThrow(() => assertTrustedLaunchPolicy(plan, config, at(90_000_000n), policies));
    assert.throws(() => assertTrustedLaunchPolicy(plan, config, at(89_999_999n), policies), /platform-approved/);
    assert.throws(() => assertTrustedLaunchPolicy({ ...plan, feeTreasury: configured }, config, at(90_000_000n), policies), /platform-approved/,
      "the engine is trusted only with its own operations treasury");
  }
  assert.equal(trustedLaunchPolicies(robinhood(), deployed("partially_deployed")).filter((policy) => policy.feePolicy === ENGINE_FEE_POLICY).length, 0);
});

test("an operator-configured engine is never trusted, even on a local fork, and Base ignores the Robinhood manifest", () => {
  for (const configuredEngine of [unknown, neverActivated])
    for (const config of [robinhood({ feeEngine: configuredEngine }), robinhood({ mode: "fork", chainId: 31337, feeEngine: configuredEngine })]) {
      const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: configured, feeEngine: configuredEngine };
      for (const block of [1n, 10n ** 12n]) assert.throws(() => assertTrustedLaunchPolicy(plan, config, at(block)), /platform-approved/,
        `${config.mode} ${configuredEngine}: engines come only from the committed manifest`);
      assert(!trustedLaunchPolicies(config).some((policy) => policy.feePolicy === ENGINE_FEE_POLICY));
    }
  const baseConfig: RuntimeConfig = { mode: "base", deploymentChainId: 8453, chainId: 8453, treasury: configured, writesEnabled: false, blockReason: null };
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: configured }, baseConfig, at(1n)));
  assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: operations }, baseConfig, at(1n)));
  assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engine }, baseConfig, at(10n ** 9n),
    trustedLaunchPolicies(baseConfig, deployed())));
  assert.deepEqual(trustedLaunchPolicies({ ...baseConfig, treasury: null }), [], "no configured treasury trusts nothing on Base");
});

test("after the recorded engine cutover, treasury-only routing is trusted only through the signing window", () => {
  const cutoverAt = 1_900_000_000;
  const withCutover = { ...deployed(), engineLaunchCutover: { blockNumber: "95000000", blockHash: `0x${"ab".repeat(32)}` as `0x${string}`, timestamp: cutoverAt } };
  const lastAccepted = BigInt(cutoverAt + 300 + 60 - 1);
  for (const config of [robinhood(), robinhood({ treasury: operations })]) {
    const policies = trustedLaunchPolicies(config, withCutover);
    for (const treasury of [config.treasury!, operations]) {
      assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: treasury }, config, at(95_000_100n, lastAccepted), policies),
        "a preview accepted just before the cutover may still be mined within its signing window");
      assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: treasury }, config, at(95_000_200n, lastAccepted + 1n), policies),
        /platform-approved/, "a treasury-only launch after the window would bypass the buyback");
    }
    assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engine }, config,
      at(95_000_200n, lastAccepted + 1n), policies));
  }
  assert.equal(engineLaunchCutover(robinhood(), withCutover)?.timestamp, cutoverAt);
  assert.equal(engineLaunchCutover(robinhood(), ENGINE_MANIFEST), undefined, "no cutover is recorded before V2 activation");
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: operations }, robinhood(), at(10n ** 12n, 10n ** 12n),
    trustedLaunchPolicies(robinhood(), deployed())), "without a cutover, treasury-only routing has no time bound");
  const baseConfig: RuntimeConfig = { mode: "base", deploymentChainId: 8453, chainId: 8453, treasury: configured, writesEnabled: false, blockReason: null };
  assert.equal(engineLaunchCutover(baseConfig, withCutover), undefined);
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: configured }, baseConfig, at(10n ** 12n, 10n ** 12n),
    trustedLaunchPolicies(baseConfig, withCutover)), "Base has no engine and keeps treasury routing");
});

test("plan attestations bind key, chain and preview id, and keys are validated and redacted", () => {
  const key = "k".repeat(32), id = `0x${"12".repeat(32)}` as `0x${string}`;
  const attestation = planAttestation(key, 4663, id);
  assert(verifyPlanAttestation([key], 4663, id, attestation));
  assert(verifyPlanAttestation(["x".repeat(32), key], 4663, id, attestation.toUpperCase().replace("0X", "0x")));
  for (const [keys, chain, preview, value] of [
    [["x".repeat(32)], 4663, id, attestation], [[key], 8453, id, attestation], [[key], 4663, `0x${"13".repeat(32)}`, attestation],
    [[key], 4663, id, "0x1234"], [[key], 4663, id, 42], [[], 4663, id, attestation],
  ] as const) assert.equal(verifyPlanAttestation(keys, chain, preview as `0x${string}`, value), false);
  assert.throws(() => runtimeFromEnv(4663, { CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", PLAN_ATTESTATION_KEY: "short" }), /at least 32 characters/);
  assert.throws(() => runtimeFromEnv(4663, { CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", PLAN_ATTESTATION_KEY: key, PLAN_ATTESTATION_PREVIOUS_KEYS: "short" }), /at least 32/);
  const runtime = runtimeFromEnv(4663, { CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", PLAN_ATTESTATION_KEY: key, PLAN_ATTESTATION_PREVIOUS_KEYS: ` ${"p".repeat(32)} ,` });
  assert.equal(runtime.secrets?.planAttestationKey, key); assert.deepEqual(runtime.secrets?.planAttestationPreviousKeys, ["p".repeat(32)]);
  assert.equal(redact(`leaked ${key} and ${"p".repeat(32)}`, { PLAN_ATTESTATION_KEY: key, PLAN_ATTESTATION_PREVIOUS_KEYS: `${"p".repeat(32)}` }), "leaked [redacted] and [redacted]");
});
