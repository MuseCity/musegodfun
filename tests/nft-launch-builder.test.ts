import test from "node:test";
import assert from "node:assert/strict";
import { DopplerSDK, airlockAbi, computePoolId } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, encodeFunctionData, http, keccak256, type Address, type Hex } from "viem";
import { ROBINHOOD_CONTRACTS, ROBINHOOD_STOCKS, STOCKS, WAD, contractsFor, type RuntimeConfig } from "../src/lib/config";
import { buildLaunch, tokenMetadata, launchFeeData, assertNftFeeCalldata } from "../src/lib/protocol";
import { MUSES, vaultFor, treasuryFor, type NftVaultManifest } from "../src/lib/nft-mode";
import { syntheticOpeningValuation } from "./fixtures";
import { FEE_POLICY, FEE_SHARES } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { serializePrepared, type LaunchPlan } from "../src/lib/launch-plan";
import { assertAcceptedLaunchRefresh, assertLaunchWalletPlan } from "../src/lib/launch-wallet";
import { assertPlanIntegrity } from "../server/launch-verification";
import { LaunchpadService } from "../server/service";

const creator = "0x1111111111111111111111111111111111111111" as Address;
const treasury = "0x2222222222222222222222222222222222222222" as Address;
const owner = "0x5555555555555555555555555555555555555555" as Address;
const factory = "0x9999999999999999999999999999999999999999" as Address;
const musegod = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "MUSEGOD")!;
const draft = { name: "Bard", symbol: "BARD", description: "", image: "", quoteAddress: musegod.address, tradingFeeBps: 100,
  nft: { chainId: 4663 as const, contract: MUSES.contract, tokenId: "1" } };
const manifest: NftVaultManifest = { version: 1, vaultInitCodeHash: keccak256("0x01"), chains: {
  "4663": { status: "deployed_verified", factory, factoryRuntimeHash: keccak256("0x02"), transactionHash: null, blockNumber: 1 },
  "8453": { status: "not_deployed", factory: null, factoryRuntimeHash: null, transactionHash: null, blockNumber: null } } };
const sdk = () => new DopplerSDK<4663>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:9") }), chainId: 4663 });
// buildLaunch returns builder params; the signed calldata is their SDK encoding.
const encoded = (...args: Parameters<typeof buildLaunch>) => args[0].factory.encodeCreateMulticurveParams(buildLaunch(...args));
const valuation = () => syntheticOpeningValuation(musegod.address, "100", { chainId: 4663 });

test("NFT launches pay both creator shares to the derived vault", () => {
  const vault = vaultFor(draft.nft, factory, manifest.vaultInitCodeHash);
  const params = encoded(sdk(), draft, creator, treasury, owner, valuation(),
    undefined, 4663, undefined, false, undefined, manifest);
  const { pool, hook } = launchFeeData(params.poolInitializerData);
  assert.equal(pool.beneficiaries.find((b) => b.beneficiary === vault)?.shares, WAD * BigInt(FEE_SHARES.creator) / 10_000n);
  assert.equal(hook.feeBeneficiaries.find((b) => b.beneficiary === vault)?.shares, WAD * BigInt(FEE_SHARES.creatorNet) / 10_000n);
  assert.equal(pool.beneficiaries.some((b) => b.beneficiary === creator), false);
  assert.equal(hook.feeBeneficiaries.some((b) => b.beneficiary === creator), false);
  assert.doesNotThrow(() => assertNftFeeCalldata({ draft, creator }, params.poolInitializerData, 4663, manifest));
});

test("assertNftFeeCalldata rejects a launch that names another fee recipient", () => {
  const params = encoded(sdk(), { ...draft, nft: undefined }, creator, treasury, owner, valuation(), undefined, 4663);
  assert.throws(() => assertNftFeeCalldata({ draft, creator }, params.poolInitializerData, 4663, manifest), /NFT fee vault/);
});

test("metadata gains properties.nft only for NFT launches; normal launches are byte-identical", () => {
  const plain = { ...draft, nft: undefined };
  const before = JSON.stringify(tokenMetadata(plain, valuation(), 4663));
  assert.equal(before.includes("\"nft\""), false);
  const nftMeta = tokenMetadata(draft, valuation(), 4663, undefined, false, undefined, manifest).properties as Record<string, unknown>;
  assert.deepEqual(nftMeta.nft, { chainId: 4663, contract: MUSES.contract, tokenId: "1",
    vault: vaultFor(draft.nft, factory, manifest.vaultInitCodeHash), treasury: treasuryFor(draft.nft) });
});

test("an NFT launch refuses to build when the factory is not deployed", () => {
  const missing = { ...manifest, chains: { ...manifest.chains, "4663": { ...manifest.chains["4663"], status: "not_deployed" as const, factory: null } } };
  assert.throws(() => buildLaunch(sdk(), draft, creator, treasury, owner, valuation(),
    undefined, 4663, undefined, false, undefined, missing), /not deployed and verified/);
});

test("a pre-NFT plan re-encodes to identical calldata", () => {
  const plain = { ...draft, nft: undefined }, fixed = valuation();
  const a = encoded(sdk(), plain, creator, treasury, owner, fixed, undefined, 4663);
  const b = encoded(sdk(), JSON.parse(JSON.stringify(plain)), creator, treasury, owner, fixed, undefined, 4663);
  assert.equal(a.poolInitializerData, b.poolInitializerData);
  assert.equal(a.tokenFactoryData, b.tokenFactoryData);
});

// Wiring: every surface that re-checks a plan must enforce the NFT fee binding.
// The committed manifest is not_deployed, so an NFT-bearing plan fails closed in production code paths.
const token = "0x4444444444444444444444444444444444444444" as Address;
const nftRef = draft.nft;
const withNft = (plan: LaunchPlan): LaunchPlan => ({ ...plan, draft: { ...plan.draft, nft: nftRef } });

function robinhoodPlan(): LaunchPlan {
  const { nft: _nft, ...plain } = draft;
  const s = sdk(), openingValuation = valuation();
  const createParams = s.factory.encodeCreateMulticurveParams(buildLaunch(s, plain, creator, treasury, owner, openingValuation, undefined, 4663));
  const poolKey = { currency0: token, currency1: musegod.address, fee: 8388608, tickSpacing: 10, hooks: ROBINHOOD_CONTRACTS.initializer };
  const transaction = { to: ROBINHOOD_CONTRACTS.airlock, data: encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [createParams] }), value: 0n };
  const prepared = { chainId: 4663 as const, account: creator, airlock: ROBINHOOD_CONTRACTS.airlock, createParams,
    prediction: { tokenAddress: token, poolOrHookAddress: token, governanceAddress: treasury, timelockAddress: treasury, poolKey, poolId: computePoolId(poolKey), tokenIsCurrency0: true },
    transaction, gasEstimate: { status: "unavailable" as const } };
  return { id: keccak256(transaction.data), creator, data: transaction.data, tokenAddress: token, poolId: prepared.prediction.poolId, draft: plain,
    preparedAt: Date.now(), gas: null, feePolicy: FEE_POLICY, feeTreasury: treasury, openingValuation, curvePolicy: CURVE_POLICY,
    prepared: serializePrepared(prepared), transaction: { ...transaction, value: "0" } };
}

test("assertPlanIntegrity enforces the NFT fee binding and still accepts a normal plan", () => {
  const plan = robinhoodPlan();
  assert.doesNotThrow(() => assertPlanIntegrity(plan, ROBINHOOD_CONTRACTS));
  assert.throws(() => assertPlanIntegrity(withNft(plan), ROBINHOOD_CONTRACTS), /not deployed and verified/);
});

test("assertLaunchWalletPlan enforces the NFT fee binding and still accepts a normal plan", () => {
  const config: RuntimeConfig = { mode: "base", chainId: 8453, treasury: creator, writesEnabled: true, blockReason: null, curvePolicy: CURVE_POLICY };
  const quote = STOCKS[0], now = Date.now();
  const base = new DopplerSDK<8453>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:9") }), chainId: 8453 });
  const baseDraft = { name: "Test", symbol: "TEST", image: "", description: "", quoteAddress: quote.address, tradingFeeBps: 100 };
  const openingValuation = syntheticOpeningValuation(quote.address, "1", { quotedAt: now, blockNumber: "10", blockHash: keccak256("0x03") });
  const createParams = base.factory.encodeCreateMulticurveParams(buildLaunch(base, baseDraft, creator, creator, owner, openingValuation));
  const data = encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [createParams] }) as Hex;
  const plan: LaunchPlan = { id: keccak256("0x04"), creator, data, tokenAddress: owner, poolId: keccak256("0x05"), draft: baseDraft, preparedAt: now, gas: null,
    curvePolicy: CURVE_POLICY, openingValuation, transaction: { to: contractsFor(config).airlock, data, value: "0" } };
  assert.doesNotThrow(() => assertLaunchWalletPlan(plan, config, creator));
  assert.throws(() => assertLaunchWalletPlan({ ...plan, draft: { ...baseDraft, nft: { ...nftRef, chainId: 8453 as const } } }, config, creator), /not deployed and verified/);
});

test("refresh acceptance rejects any change to the NFT identity or the launch-fee payment", () => {
  const fee = (txHash: Hex) => ({ asset: "stable" as const, txHash });
  const h1 = keccak256("0x11"), h2 = keccak256("0x12");
  const mk = (extra: Partial<LaunchPlan["draft"]>): LaunchPlan => ({ creator, intentId: "intent-1", feePolicy: FEE_POLICY, feeTreasury: treasury,
    draft: { ...draft, nft: nftRef, launchFee: fee(h1), ...extra } } as unknown as LaunchPlan);
  const previous = mk({});
  assert.doesNotThrow(() => assertAcceptedLaunchRefresh(previous, mk({})));
  assert.doesNotThrow(() => assertAcceptedLaunchRefresh(previous, mk({ nft: { ...nftRef, contract: nftRef.contract.toLowerCase() as Address } })), "contract case is not identity");
  for (const changed of [{ nft: { ...nftRef, tokenId: "2" } }, { nft: { ...nftRef, chainId: 8453 as const } },
    { nft: { ...nftRef, contract: "0x1234567890123456789012345678901234567890" as Address } }, { nft: undefined }, { launchFee: fee(h2) }, { launchFee: undefined }])
    assert.throws(() => assertAcceptedLaunchRefresh(previous, mk(changed)), /launch parameters changed/);
  assert.throws(() => assertAcceptedLaunchRefresh(mk({ nft: undefined, launchFee: undefined }), mk({})), /launch parameters changed/, "an NFT cannot appear mid-refresh");
});

test("prepare refresh must keep the same NFT and launch-fee payment", async () => {
  const fee = (txHash: Hex) => ({ asset: "stable" as const, txHash });
  const h1 = keccak256("0x11"), h2 = keccak256("0x12");
  const quote = STOCKS[0];
  const baseDraft = { name: "Bard", symbol: "BARD", description: "", image: "", quoteAddress: quote.address, tradingFeeBps: 100 };
  const previousDraft = { ...baseDraft, nft: { ...nftRef, chainId: 8453 as const }, launchFee: fee(h1) };
  const previous = { id: keccak256("0x21"), creator, intentId: "intent-1", prepared: {}, recovered: false, draft: previousDraft };
  const config: RuntimeConfig = { mode: "base", chainId: 8453, deploymentChainId: 8453, treasury, writesEnabled: true, blockReason: null };
  let network = 0;
  const service = Object.assign(Object.create(LaunchpadService.prototype), { runtime: { config }, store: { getPlan: async () => previous },
    assertNetwork: async () => { network++; throw new Error("REACHED_NETWORK"); } }) as LaunchpadService;
  const refresh = (draftInput: unknown) => service.prepare(draftInput, creator, CURVE_POLICY, undefined, { intentId: "intent-1", previousPlanId: previous.id });
  await assert.rejects(refresh(previousDraft), /REACHED_NETWORK/, "an identical NFT and payment pass the refresh gate");
  assert.equal(network, 1);
  const bad = [{ ...previousDraft, nft: { ...previousDraft.nft, tokenId: "2" } }, { ...previousDraft, nft: { ...previousDraft.nft, chainId: 4663 as const } },
    { ...previousDraft, nft: { ...previousDraft.nft, contract: "0x1234567890123456789012345678901234567890" } },
    { ...previousDraft, nft: undefined }, { ...previousDraft, launchFee: fee(h2) }, { ...previousDraft, launchFee: undefined }];
  for (const changed of bad) await assert.rejects(refresh(changed), /same creator, intent and reviewed purchase/);
  assert.equal(network, 1, "every changed draft is refused before any network work");
});
