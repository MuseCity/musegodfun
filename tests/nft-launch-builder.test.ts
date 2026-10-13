import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DopplerSDK, airlockAbi, computePoolId } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, encodeFunctionData, http, keccak256, type Address, type Hex } from "viem";
import { ROBINHOOD_CONTRACTS, ROBINHOOD_STOCKS, STOCKS, WAD, contractsFor, type RuntimeConfig } from "../src/lib/config";
import { buildLaunch, tokenMetadata, launchFeeData, assertEngineFeeCalldata, assertNftFeeCalldata } from "../src/lib/protocol";
import { MUSES, NFT_VAULT_MANIFEST, vaultFor, treasuryFor, type NftVaultManifest } from "../src/lib/nft-mode";
import { syntheticOpeningValuation } from "./fixtures";
import { ENGINE_FEE_POLICY, FEE_POLICY, FEE_SHARES } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { serializePrepared, type LaunchPlan } from "../src/lib/launch-plan";
import { assertAcceptedLaunchRefresh, assertLaunchWalletPlan } from "../src/lib/launch-wallet";
import { assertPlanIntegrity, assertRecoveryPlan } from "../server/launch-verification";
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

// Golden pins. These hashes were computed from src/lib/protocol.ts at commit 00e1ac7 (before Task 4) with the
// same fixed inputs, so a match proves normal-mode calldata is byte-identical to the pre-NFT build.
const FROZEN_NOW = 1_800_000_000_000;
const engine = "0x3333333333333333333333333333333333333333" as Address;
const GOLDEN = {
  "robinhood-plain": { pool: "0x553aef174f07c128729c6eb10a712f322b21856f20ca86fb04f0dbb4be8ed7b1", token: "0x8410c6f0e343e93f5fad2234550f3d7fd4906f730eda8a6152bcd291538dcf94" },
  "robinhood-engine": { pool: "0xfcaf4fe1eb80f7124b87291a11c890340f3ef4942ebe8858827b89703e7bf0d1", token: "0x8c6a8c97b5bccbb4b404103bc34eaeb300f1dfea884a01dc4234fa5abdf75c2c" },
  "base-engine": { pool: "0xc74fd5cb29d4e3d2c2c97f0bbb3cd39ddd18eaff192b166bdcb23032abf7df05", token: "0xc597357f83b93f45ac3923e16dffe8c193dba924dd6e1f9b0023b820e466e501" },
} as const;

test("normal-mode calldata is byte-identical to the pre-NFT build (golden hashes from 00e1ac7)", (t) => {
  t.mock.method(Date, "now", () => FROZEN_NOW);
  const salt = `0x${"11".repeat(32)}` as Hex;
  const pre = (quoteAddress: Address) => ({ name: "Bard", symbol: "BARD", description: "d", image: "", quoteAddress, tradingFeeBps: 100 });
  const rpc = () => createPublicClient({ transport: http("http://127.0.0.1:9") });
  const robinhood = new DopplerSDK<4663>({ publicClient: rpc(), chainId: 4663 }), base = new DopplerSDK<8453>({ publicClient: rpc(), chainId: 8453 });
  const hashes = (name: keyof typeof GOLDEN, sdk: DopplerSDK<8453 | 4663>, chainId: 8453 | 4663, quote: Address, feeEngine?: Address, input = pre(quote)) => {
    const valuation = syntheticOpeningValuation(quote, "100", { chainId, quotedAt: FROZEN_NOW });
    const params = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, input, creator, treasury, owner, valuation, salt, chainId, feeEngine));
    return { name, pool: keccak256(params.poolInitializerData), token: keccak256(params.tokenFactoryData) };
  };
  for (const [name, sdk, chainId, quote, feeEngine] of [
    ["robinhood-plain", robinhood, 4663, musegod.address, undefined], ["robinhood-engine", robinhood, 4663, musegod.address, engine],
    ["base-engine", base, 8453, STOCKS[0].address, engine]] as const) {
    const got = hashes(name, sdk, chainId, quote, feeEngine);
    assert.deepEqual({ pool: got.pool, token: got.token }, GOLDEN[name], name);
  }
  // A draft that carries an explicit undefined `nft` (the shape the form now produces) is the same launch.
  const explicitUndefined = hashes("robinhood-plain", robinhood, 4663, musegod.address, undefined, { ...pre(musegod.address), nft: undefined } as never);
  assert.deepEqual({ pool: explicitUndefined.pool, token: explicitUndefined.token }, GOLDEN["robinhood-plain"]);
});

test("fee engine + NFT (the Robinhood production combination) keeps engine shares and pays the creator shares to the vault", () => {
  const vault = vaultFor(draft.nft, factory, manifest.vaultInitCodeHash);
  const params = encoded(sdk(), draft, creator, treasury, owner, valuation(), undefined, 4663, engine, false, undefined, manifest);
  assert.doesNotThrow(() => assertEngineFeeCalldata({ feePolicy: ENGINE_FEE_POLICY, feeEngine: engine, creator, feeTreasury: treasury }, params.poolInitializerData));
  assert.doesNotThrow(() => assertNftFeeCalldata({ draft, creator }, params.poolInitializerData, 4663, manifest));
  const { pool, hook } = launchFeeData(params.poolInitializerData);
  const bps = (value: number) => WAD * BigInt(value) / 10_000n;
  const byAddress = (rows: readonly { beneficiary: Address; shares: bigint }[]) => Object.fromEntries(rows.map((row) => [row.beneficiary, row.shares]));
  assert.deepEqual(byAddress(pool.beneficiaries), { [owner]: bps(500), [vault]: bps(6650), [treasury]: bps(570), [engine]: bps(2280) });
  assert.deepEqual(byAddress(hook.feeBeneficiaries), { [vault]: bps(7000), [treasury]: bps(600), [engine]: bps(2400) });
  const properties = tokenMetadata(draft, valuation(), 4663, engine, false, undefined, manifest).properties as Record<string, unknown>;
  assert.equal(properties.feePolicy, ENGINE_FEE_POLICY); assert.equal(properties.feeEngine, engine);
  assert.deepEqual(properties.nft, { chainId: 4663, contract: MUSES.contract, tokenId: "1", vault, treasury: treasuryFor(draft.nft) });
});

test("an NFT vault that collides with another beneficiary is refused before shares can merge", () => {
  // A CREATE2 preimage for DEAD or the zero address cannot be constructed, so those two entries of the shared
  // list are not exercised; the creator, treasury and protocol-owner collisions are built by setting that party to the vault.
  const vault = vaultFor(draft.nft, factory, manifest.vaultInitCodeHash);
  const build = (c: Address, tr: Address, o: Address, feeEngine?: Address) => () =>
    buildLaunch(sdk(), draft, c, tr, o, valuation(), undefined, 4663, feeEngine, false, undefined, manifest);
  assert.doesNotThrow(build(creator, treasury, owner));
  assert.throws(build(vault, treasury, owner), /NFT fee vault must be a distinct beneficiary/);
  assert.throws(build(creator, vault, owner), /NFT fee vault must be a distinct beneficiary/);
  assert.throws(build(creator, treasury, vault), /NFT fee vault must be a distinct beneficiary/);
  assert.throws(build(vault.toLowerCase() as Address, treasury, owner), /NFT fee vault must be a distinct beneficiary/, "address case does not matter");
  assert.throws(build(creator, treasury, owner, vault), /fee engine must be a distinct beneficiary/, "the fee engine cannot be the vault either");
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
  // The prepare-time NFT rules (Task 5) run before the refresh gate, so this fixture presents an enabled NFT mode with a declared factory.
  const config: RuntimeConfig = { mode: "base", chainId: 8453, deploymentChainId: 8453, treasury, writesEnabled: true, blockReason: null,
    nftMode: { enabled: true, vaultFactory: "0x00000000000000000000000000000000000fac70", launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } };
  let network = 0;
  const service = Object.assign(Object.create(LaunchpadService.prototype), { runtime: { config }, store: { getPlan: async () => previous },
    assertNetwork: async () => { network++; throw new Error("REACHED_NETWORK"); } }) as LaunchpadService;
  const refresh = (draftInput: unknown) => service.prepare(draftInput, creator, CURVE_POLICY, undefined, { intentId: "intent-1", previousPlanId: previous.id });
  await assert.rejects(refresh(previousDraft), /REACHED_NETWORK/, "an identical NFT and payment pass the refresh gate");
  assert.equal(network, 1);
  const bad = [{ ...previousDraft, nft: { ...previousDraft.nft, tokenId: "2" } }, { ...previousDraft, nft: { ...previousDraft.nft, chainId: 4663 as const } },
    { ...previousDraft, nft: { ...previousDraft.nft, contract: "0x1234567890123456789012345678901234567890" } },
    { ...previousDraft, nft: undefined }, { ...previousDraft, launchFee: fee(h2) }, { ...previousDraft, launchFee: undefined }];
  // A token moved to another chain is refused by the NFT chain rule even earlier; every other change by the refresh gate.
  for (const changed of bad) await assert.rejects(refresh(changed), changed.nft?.chainId === 4663 ? /own network/ : /same creator, intent and reviewed purchase/);
  assert.equal(network, 1, "every changed draft is refused before any network work");
});

// ---- the runtime manifest seam (Runtime.nftVaultManifest) ---------------------------------------------------------------------
// A plan whose calldata pays the vault of `manifest`'s factory, the way prepare builds it when the runtime carries that manifest.
function nftPlan(): LaunchPlan {
  const plan = robinhoodPlan(), s = sdk();
  const createParams = s.factory.encodeCreateMulticurveParams(buildLaunch(s, draft, creator, treasury, owner, plan.openingValuation!,
    undefined, 4663, undefined, false, undefined, manifest));
  const transaction = { to: ROBINHOOD_CONTRACTS.airlock, data: encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [createParams] }), value: 0n };
  const prepared = { ...JSON.parse(JSON.stringify(plan.prepared)), createParams, transaction } as Record<string, unknown>;
  const restored = { chainId: 4663 as const, account: creator, airlock: ROBINHOOD_CONTRACTS.airlock, createParams,
    prediction: { ...(prepared.prediction as object) } as never, transaction, gasEstimate: { status: "unavailable" as const } };
  return { ...plan, id: keccak256(transaction.data), data: transaction.data, draft, prepared: serializePrepared(restored),
    transaction: { ...transaction, value: "0" } };
}
const outcomeOf = (run: () => unknown) => { try { run(); return "ok"; } catch (e) { return (e as Error).message; } };

test("the default manifest is the committed file, and the integrity and recovery checks use an injected one only when it is passed", () => {
  const committed = JSON.parse(readFileSync(new URL("../contracts/artifacts/nft-vault-deployment.json", import.meta.url), "utf8"));
  assert.deepEqual(NFT_VAULT_MANIFEST, committed, "the default path reads contracts/artifacts/nft-vault-deployment.json");
  const plan = nftPlan(), s = sdk();
  // Omitting the manifest is the same as passing the committed one (not_deployed today, so an NFT plan fails closed).
  assert.equal(outcomeOf(() => assertPlanIntegrity(plan, ROBINHOOD_CONTRACTS)), outcomeOf(() => assertPlanIntegrity(plan, ROBINHOOD_CONTRACTS, NFT_VAULT_MANIFEST)));
  assert.equal(outcomeOf(() => assertRecoveryPlan(plan, ROBINHOOD_CONTRACTS, s)), outcomeOf(() => assertRecoveryPlan(plan, ROBINHOOD_CONTRACTS, s, NFT_VAULT_MANIFEST)));
  if (NFT_VAULT_MANIFEST.chains["4663"].status === "not_deployed") {
    assert.throws(() => assertPlanIntegrity(plan, ROBINHOOD_CONTRACTS), /not deployed and verified/);
    assert.throws(() => assertRecoveryPlan(plan, ROBINHOOD_CONTRACTS, s), /not deployed and verified/);
  }
  assert.doesNotThrow(() => assertPlanIntegrity(plan, ROBINHOOD_CONTRACTS, manifest));
  assert.doesNotThrow(() => assertRecoveryPlan(plan, ROBINHOOD_CONTRACTS, s, manifest), "recovery re-encodes the same vault from the injected manifest");
  const elsewhere: NftVaultManifest = { ...manifest, chains: { ...manifest.chains, "4663": { ...manifest.chains["4663"], factory: "0x8888888888888888888888888888888888888888" } } };
  assert.throws(() => assertPlanIntegrity(plan, ROBINHOOD_CONTRACTS, elsewhere), /NFT fee vault/, "another factory's vault is refused");
});

test("the service checks a saved NFT plan against its runtime manifest, and against the committed one when the runtime has none", async () => {
  const plan = nftPlan();
  const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury, writesEnabled: true, blockReason: null, curvePolicy: CURVE_POLICY };
  const service = (nftVaultManifest?: NftVaultManifest) => Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config, ...(nftVaultManifest ? { nftVaultManifest } : {}) },
    store: { findPlan: async () => plan },
    config: async () => { throw new Error("REACHED_CONFIG"); },
  }) as LaunchpadService;
  await assert.rejects(service(manifest).validateLaunch(creator, plan.data), /REACHED_CONFIG/, "the injected manifest's vault passes the integrity check");
  const committed = await service().validateLaunch(creator, plan.data).then(() => "ok", (e: Error) => e.message);
  assert.equal(committed, outcomeOf(() => assertPlanIntegrity(plan, ROBINHOOD_CONTRACTS, NFT_VAULT_MANIFEST)),
    "without a runtime manifest the service judges the plan exactly as the committed manifest does");
});
