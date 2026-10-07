import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import type { RuntimeConfig } from "../src/lib/config";
import { ENGINE_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import { assertTrustedLaunchPolicy, ENGINE_MANIFESTS, ENGINE_TRUST_WINDOWS, trustedLaunchPolicies } from "../server/launch-policy-registry";

const configured = "0x2222222222222222222222222222222222222222" as Address;
const operations = "0xc4F87C3715374445C4657aa14c47CBB339b59d1A" as Address;
const engineV1 = "0x2f1FD06e3b6Dd81123629d08a74A6279Ea03797f" as Address;
const engineV2 = "0x3333333333333333333333333333333333333333" as Address;
const unknown = "0x9999999999999999999999999999999999999999" as Address;
const robinhood = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig =>
  ({ mode: "robinhood", deploymentChainId: 4663, chainId: 4663, treasury: configured, writesEnabled: false, blockReason: "paused", ...overrides });
const v1Block = 81_459_143n;
const manifest = (address: Address | null, blockNumber?: string, status = "deployed_verified") =>
  ({ chainId: 4663, status, constants: { treasury: operations }, contracts: { engine: { address, ...(blockNumber ? { blockNumber } : {}) } } });

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
    { feePolicy: "musegod-80-v1" as const, feeTreasury: configured },
  ] as const) assert.throws(() => assertTrustedLaunchPolicy(plan, config, v1Block + 1n), /platform-approved/, JSON.stringify(plan));
});

test("the never-activated V1 engine is untrusted at every block, including future ones", () => {
  const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engineV1 };
  for (const config of [robinhood(), robinhood({ treasury: operations, feeEngine: engineV1 }), robinhood({ treasury: null, signingPaused: true })])
    for (const block of [v1Block - 1n, v1Block, v1Block + 1_000_000n, 10n ** 12n])
      assert.throws(() => assertTrustedLaunchPolicy(plan, config, block), /platform-approved/, `${config.feeEngine} ${block}`);
  assert(!trustedLaunchPolicies(robinhood()).some((policy) => policy.feePolicy === ENGINE_FEE_POLICY), "the committed manifests trust no engine yet");
});

test("a deployed engine is trusted from its creation block, and a retired one only until its recorded replacement", () => {
  const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: operations, feeEngine: engineV2 };
  const manifests = [manifest(engineV1, "81459143"), manifest(engineV2, "90000000")];
  const current = trustedLaunchPolicies(robinhood(), manifests);
  assert.doesNotThrow(() => assertTrustedLaunchPolicy(plan, robinhood(), 90_000_000n, current));
  assert.doesNotThrow(() => assertTrustedLaunchPolicy(plan, robinhood(), 10n ** 12n, current), "the current engine has no upper bound");
  assert.throws(() => assertTrustedLaunchPolicy(plan, robinhood(), 89_999_999n, current), /platform-approved/);
  const retired = trustedLaunchPolicies(robinhood(), manifests, { ...ENGINE_TRUST_WINDOWS, [engineV2.toLowerCase()]: { toBlock: 95_000_000n } });
  assert.doesNotThrow(() => assertTrustedLaunchPolicy(plan, robinhood(), 94_999_999n, retired));
  assert.throws(() => assertTrustedLaunchPolicy(plan, robinhood(), 95_000_000n, retired), /platform-approved/, "launches after retirement are rejected");
  assert.equal(trustedLaunchPolicies(robinhood(), [manifest(engineV2, "90000000", "pending_deployment")])
    .filter((policy) => policy.feePolicy === ENGINE_FEE_POLICY).length, 0);
});

test("only the newest deployed engine may stay open-ended in the committed registry", () => {
  const deployed = ENGINE_MANIFESTS.filter((entry) => entry.status === "deployed_verified" && entry.contracts.engine.address);
  for (const entry of deployed.slice(0, -1)) {
    const window = ENGINE_TRUST_WINDOWS[entry.contracts.engine.address!.toLowerCase()];
    assert(window === null || window?.toBlock !== undefined, `${entry.contracts.engine.address} needs a retirement block before a newer engine is deployed`);
  }
});

test("an operator-configured engine is trusted only on a local fork, and Base ignores Robinhood manifests", () => {
  const plan = { feePolicy: ENGINE_FEE_POLICY, feeTreasury: configured, feeEngine: unknown };
  assert.throws(() => assertTrustedLaunchPolicy(plan, robinhood({ feeEngine: unknown }), 1n), /platform-approved/,
    "a production engine must come from a committed manifest");
  assert.doesNotThrow(() => assertTrustedLaunchPolicy(plan, robinhood({ mode: "fork", chainId: 31337, feeEngine: unknown }), 1n));
  assert.throws(() => assertTrustedLaunchPolicy({ ...plan, feeEngine: engineV1 },
    robinhood({ mode: "fork", chainId: 31337, feeEngine: engineV1 }), v1Block + 1n), /platform-approved/, "a fork cannot revive V1");
  const baseConfig: RuntimeConfig = { mode: "base", deploymentChainId: 8453, chainId: 8453, treasury: configured, writesEnabled: false, blockReason: null };
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: configured }, baseConfig, 1n));
  assert.throws(() => assertTrustedLaunchPolicy({ feePolicy: FEE_POLICY, feeTreasury: operations }, baseConfig, 1n));
  assert.deepEqual(trustedLaunchPolicies({ ...baseConfig, treasury: null }), [], "no configured treasury trusts nothing on Base");
});
