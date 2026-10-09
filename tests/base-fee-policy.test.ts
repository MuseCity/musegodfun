import test from "node:test";
import assert from "node:assert/strict";
import { DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, http, type Address } from "viem";
import { BASE_AUTOMATION_FEE_POLICY, BASE_COLLECTOR_FEE_POLICY, ENGINE_FEE_POLICY, FEE_POLICY, allocateFeeIncome, launchFeePolicy } from "../src/lib/fee-policy";
import { STOCKS, type RuntimeConfig } from "../src/lib/config";
import { buildLaunch, launchFeeData, assertEngineFeeCalldata, tokenMetadata } from "../src/lib/protocol";
import { syntheticOpeningValuation } from "./fixtures";
import { BASE_COLLECTOR_MANIFEST } from "../server/base-collector";
import { ENGINE_MANIFEST, trustedLaunchPolicies, assertTrustedLaunchPolicy } from "../server/launch-policy-registry";
const creator = "0x1111111111111111111111111111111111111111" as Address;
const treasury = "0x2222222222222222222222222222222222222222" as Address;
const collector = "0x3333333333333333333333333333333333333333" as Address;
test("Base launch calldata isolates gross LP and net hook buyback shares and identifies its own policy", () => {
  const sdk = new DopplerSDK<8453 | 4663>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }), chainId: 8453 });
  const draft = { name: "Base Fee Proof", symbol: "BFEE", description: "", image: "", quoteAddress: STOCKS[0].address };
  const valuation = syntheticOpeningValuation(STOCKS[0].address);
  const params = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, draft, creator, treasury, creator, valuation, undefined, 8453, collector));
  const fees = launchFeeData(params.poolInitializerData);
  assert.equal(fees.pool.beneficiaries.find(b => b.beneficiary.toLowerCase() === collector.toLowerCase())?.shares, 2280n * 10n ** 14n);
  assert.equal(fees.hook.feeBeneficiaries.find(b => b.beneficiary.toLowerCase() === collector.toLowerCase())?.shares, 2400n * 10n ** 14n);
  assert.doesNotThrow(() => assertEngineFeeCalldata({ feePolicy: BASE_AUTOMATION_FEE_POLICY, feeEngine: collector, feeTreasury: treasury, creator }, params.poolInitializerData));
  const metadata = tokenMetadata(draft, valuation, 8453, collector) as Record<string, any>;
  assert.equal(metadata.properties.feePolicy, BASE_AUTOMATION_FEE_POLICY);
});
test("Native fee adapter receipt allocation never applies a second platform 80/20 split", () => {
  for (const amount of [1n, 9n, 101n, 10n ** 30n]) {
    const receipt = allocateFeeIncome({ feePolicy: BASE_AUTOMATION_FEE_POLICY, amount, account: collector, creator, treasury, engine: collector });
    assert.equal(receipt?.buyback, amount); assert.equal(receipt?.operations, 0n);
  }
});
test("Base receipt registry trusts the fixed native fee adapter from cutover while retaining earlier treasury receipts", () => {
  const config: RuntimeConfig = { mode: "base", chainId: 8453, treasury, writesEnabled: false, blockReason: "paused", feeEngine: collector, feePolicy: BASE_AUTOMATION_FEE_POLICY };
  const manifest = structuredClone(BASE_COLLECTOR_MANIFEST);
  assert.equal(trustedLaunchPolicies(config, ENGINE_MANIFEST, manifest).length, 0);
  manifest.status = "deployed_verified"; manifest.collector.address = collector; manifest.collector.blockNumber = "100"; manifest.constants.operationsTreasury = treasury;
  const policies = trustedLaunchPolicies(config, ENGINE_MANIFEST, manifest);
  const newPlan = { feePolicy: BASE_AUTOMATION_FEE_POLICY, feeTreasury: treasury, feeEngine: collector };
  assert.doesNotThrow(() => assertTrustedLaunchPolicy(newPlan, config, {blockNumber:100n,timestamp:0n}, policies));
  assert.throws(() => assertTrustedLaunchPolicy(newPlan, config, {blockNumber:99n,timestamp:0n}, policies));
  assert.doesNotThrow(() => assertTrustedLaunchPolicy({feePolicy:FEE_POLICY,feeTreasury:treasury}, config, {blockNumber:99n,timestamp:0n}, policies));
  assert.throws(() => assertTrustedLaunchPolicy({feePolicy:FEE_POLICY,feeTreasury:treasury}, config, {blockNumber:100n,timestamp:0n}, policies));
});

test("new Base launches select native Automation while frozen Collector metadata remains recoverable", () => {
  const draft = { name: "Native Fee Proof", symbol: "NFEE", description: "", image: "", quoteAddress: STOCKS[0].address };
  const valuation = syntheticOpeningValuation(STOCKS[0].address);
  const current = tokenMetadata(draft, valuation, 8453, collector);
  assert.equal(current.properties.feePolicy, BASE_AUTOMATION_FEE_POLICY);
  assert.equal(current.properties.platformIncomeAllocation.execution, "splits_native_automation_relay");
  const historical = tokenMetadata(draft, valuation, 8453, collector, true, BASE_COLLECTOR_FEE_POLICY);
  assert.equal(historical.properties.feePolicy, BASE_COLLECTOR_FEE_POLICY);
  assert.equal(historical.properties.platformIncomeAllocation.execution, "signed_lifi_across_weth");
  assert.equal(launchFeePolicy({ mode: "base", feePolicy: BASE_AUTOMATION_FEE_POLICY }), BASE_AUTOMATION_FEE_POLICY);
  assert.equal(launchFeePolicy({ mode: "base", feePolicy: BASE_COLLECTOR_FEE_POLICY }), FEE_POLICY);
  assert.equal(launchFeePolicy({ mode: "robinhood", feePolicy: BASE_AUTOMATION_FEE_POLICY }), FEE_POLICY);
  assert.equal(launchFeePolicy({ mode: "robinhood", feePolicy: ENGINE_FEE_POLICY }), ENGINE_FEE_POLICY);
  const sdk = new DopplerSDK<8453 | 4663>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }), chainId: 8453 });
  const frozen = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, draft, creator, treasury, creator, valuation, undefined, 8453, collector, true, BASE_COLLECTOR_FEE_POLICY));
  assert.doesNotThrow(() => assertEngineFeeCalldata({ feePolicy: BASE_COLLECTOR_FEE_POLICY, feeEngine: collector, feeTreasury: treasury, creator }, frozen.poolInitializerData));
  for (const policy of [BASE_AUTOMATION_FEE_POLICY, BASE_COLLECTOR_FEE_POLICY]) {
    const receipt = allocateFeeIncome({ feePolicy: policy, amount: 101n, account: collector, creator, treasury, engine: collector });
    assert.equal(receipt?.buyback, 101n);
    assert.equal(receipt?.operations, 0n);
  }
});
