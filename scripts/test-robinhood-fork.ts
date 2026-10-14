import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, getAddress, keccak256,
  http, parseAbi, parseAbiItem, parseEther, parseUnits, toHex, zeroAddress,
  type Address, type Hash, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { robinhood } from "viem/chains";
import { DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { contractsFor, ROBINHOOD_STOCKS, SUPPLY, WAD, sameAddress } from "../src/lib/config";
import { claimFeesAbi, permit2Abi, swapTransaction } from "../src/lib/protocol";
import { allocateFeeIncome, ENGINE_FEE_POLICY, FEE_POLICIES } from "../src/lib/fee-policy";
import { OPENING_CAP_USD, OPENING_POLICY } from "../src/lib/opening-valuation";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { runtimeFromEnv } from "../server/config";
import { verifyFeeEngine } from "../server/buyback-engine";
import { ENGINE_MANIFEST } from "../server/launch-policy-registry";
import { LaunchpadService } from "../server/service";
import { syntheticOpeningValuation } from "../tests/fixtures";
import { isRateLimited, robinhoodUpstreamUrl, safeForkError } from "./nft-vault-fork-helpers";
import { startChainFork } from "./robinhood-fork";

// Robinhood normal-mode launch, end to end, on an isolated Anvil fork of Robinhood Chain mainnet state: create, register, restart
// recovery, buy, sell and both beneficiaries' claims for five representative quote assets, then a snapshot revert and orphan cleanup.
// - Environment: only .env.fork (ALCHEMY_API_KEY), loaded by `node --env-file`. The real .env is never read; every other value the
//   service needs (the plan-attestation key, the store directory) is a throwaway generated here.
// - Fee engine: the deployed engine and its operations treasury, from the committed engine manifest, are only candidates. The
//   production path (LaunchpadService.config -> verifyFeeEngine) verifies them against the fork's state, so launches use
//   ENGINE_FEE_POLICY. Nothing on that path is stubbed.
// - Network: the fork's read-only upstream proxy, one direct read of the upstream `finalized` block (recorded only) and, only if the
//   v4 PoolManager cannot fund an asset, a bounded Transfer-log scan (at most ten 10-block windows); a 429 stops the run. Everything
//   else is 127.0.0.1. LI.FI is outside that set, so launches are priced from a synthetic opening valuation; each pool must still open
//   at that valuation, within tick rounding.
// - Writes: local fork transactions only, sent with eth_sendTransaction from a fresh random creator (its key is never used to sign)
//   or from mainnet accounts impersonated on the fork. No signature valid on mainnet is produced, and nothing is sent to mainnet.
// - Execution chain id 4663: verifyFeeEngine accepts the engine's activation only from an RPC that reports chain id 4663
//   (server/buyback-activation.ts, verifyCurrentActivationAuthority), so a 31337 fork never offers the engine and every Robinhood
//   prepare is refused. The fork therefore keeps 4663, as scripts/test-nft-launch-fork.ts does. validateLaunch's signing gate admits a
//   fork only as 31337 (src/lib/validation.ts, assertSigningEnabled), so under the engine policy no fork can pass both: here every
//   validateLaunch check before that gate must pass and it must stop exactly at the gate.

const key = process.env.ALCHEMY_API_KEY ?? "";
const upstreamUrl = robinhoodUpstreamUrl(key);
const redact = (error: unknown) => safeForkError(error, [key]);
if (!process.env.ANVIL_BIN?.trim() && !existsSync(".cache/bin/base-anvil-v1.1.1/anvil"))
  process.env.ANVIL_BIN = execFileSync("which", ["anvil"], { encoding: "utf8" }).trim();

const CHAIN_ID = 4663;
const EXECUTION_CHAIN_ID = CHAIN_ID;
const SIGNING_NETWORK_GATE = "The signing network does not match the platform mode";
// reconcile stops re-checking a launch once the node reports it finalized, and Anvil's default `finalized` trails the head by only 64
// blocks; this run mines more than that. A live chain takes far longer, so the fork trails by 2,000 blocks and the reorganization check
// asserts that no tested launch was final when the chain reorganized.
const FINALITY_LAG_BLOCKS = 2_000;
// A confirmed launch that is not final yet is re-checked when it is next due, at most 60 seconds later (server/service.ts, reconcile).
const ORPHAN_CLEANUP_MAX_WAIT_MS = 75_000;
const PASSED_EVIDENCE = "docs/evidence/robinhood-fork.json";
const FAILED_EVIDENCE = ".cache/robinhood-fork-failed.json";
const ENGINE = getAddress(ENGINE_MANIFEST.contracts.engine.address ?? "");
const OPERATIONS_TREASURY = getAddress(ENGINE_MANIFEST.constants.treasury ?? "");
const testedTickers = ["WETH", "NVDA", "USDG", "cbBTC", "MUSEGOD"];
// Synthetic USD prices for the opening valuation only (LI.FI is not reachable in this run).
const SYNTHETIC_PRICE_USD: Record<string, string> = { WETH: "3000", NVDA: "180", USDG: "1", cbBTC: "100000", MUSEGOD: "0.0003" };
// ENGINE_FEE_POLICY on-chain shares. The initializer (LP fees) pays protocol 500 / creator 6650 / operations 570 / engine 2280 bps;
// Rehype (hook fees) pays creator 7000 / operations 3000 x 20% = 600 / engine 3000 x 80% = 2400 bps.
const expectedShares = {
  initializer: { protocolOwner: WAD * 5n / 100n, creator: WAD * 665n / 1000n, treasury: WAD * 57n / 1000n, engine: WAD * 228n / 1000n },
  rehype: { creator: WAD * 70n / 100n, treasury: WAD * 6n / 100n, engine: WAD * 24n / 100n },
};
const enginePolicy = FEE_POLICIES[ENGINE_FEE_POLICY];
const bps = (value: number) => WAD * BigInt(value) / 10_000n;
assert.deepEqual(expectedShares, {
  initializer: { protocolOwner: bps(enginePolicy.protocol), creator: bps(enginePolicy.creator), treasury: bps(enginePolicy.operations), engine: bps(enginePolicy.buyback) },
  rehype: { creator: bps(enginePolicy.creatorNet), treasury: bps(enginePolicy.platformNet * enginePolicy.platformOperations / 10_000),
    engine: bps(enginePolicy.platformNet * enginePolicy.platformBuyback / 10_000) },
}, "The expected shares must follow ENGINE_FEE_POLICY");
for (const shares of Object.values(expectedShares)) assert.equal(Object.values(shares).reduce((sum, share) => sum + share, 0n), WAD);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const serialize = (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value;
/** Evidence text: never the API key, never a URL. Used on every write path, the fork-start failure included. */
function evidenceText(value: unknown) {
  const text = JSON.stringify(value, serialize, 2) + "\n";
  assert(!key || !text.includes(key), "Evidence must not contain the API key");
  assert(!/https?:\/\//i.test(text), "Evidence must not contain a URL");
  return text;
}
const evidence = {
  version: 1,
  scope: "Isolated Anvil fork of Robinhood Chain mainnet state, execution chain id 4663; local fork transactions only (unsigned eth_sendTransaction from impersonated accounts); no mainnet signing or broadcast",
  status: "running" as string, stage: "initializing", observedAt: new Date().toISOString(), completedAt: null as string | null,
  upstreamChainId: CHAIN_ID, executionChainId: EXECUTION_CHAIN_ID,
  runnerSha256: sha256(await readFile(new URL(import.meta.url), "utf8")),
  anvil: execFileSync(process.env.ANVIL_BIN?.trim() || ".cache/bin/base-anvil-v1.1.1/anvil", ["--version"], { encoding: "utf8" }).split("\n")[0],
  forkBlockNumber: null as bigint | null, forkBlockHash: null as Hex | null, forkBlockTimestamp: null as bigint | null,
  environment: { loaded: ".env.fork (ALCHEMY_API_KEY only)", throwaway: ["PLAN_ATTESTATION_KEY", "DATA_DIR"],
    store: "isolated SQLite in the operating-system temporary directory" },
  feeEngine: null as Record<string, unknown> | null,
  openingValuation: { kind: "synthetic", reason: "LI.FI is outside this run's network", quotePriceUsd: SYNTHETIC_PRICE_USD },
  expectedShares,
  actors: null as Record<string, unknown> | null,
  contracts: null as Record<string, Address> | null,
  representativeAssetsExpected: testedTickers,
  curatedWhitelistPolicy: { excluded: ["U", "PAIR"], custom: ["MUSEGOD"] },
  assets: [] as Record<string, unknown>[],
  fullFlowPassed: false,
  engineClaimExecuted: false, buybackOrBurnExecuted: false, baseFeeBridgingExecuted: false,
  gasModelScope: "EVM contract flow only; not Robinhood sequencer, L1 data fee, or finality acceptance",
  mainnetTransactionsSubmitted: false, blockedUpstreamWrites: null as number | null, snapshotRestored: false,
  finality: { forkFinalityLagBlocks: FINALITY_LAG_BLOCKS, upstreamFinalizedLagAtFork: null as bigint | null,
    finalizedHeadBeforeRevert: null as bigint | null, lowestLaunchBlock: null as bigint | null },
  orphanedRecordsRemoved: null as boolean | null, orphanCleanup: null as Record<string, unknown> | null,
  error: null as string | null,
};
await mkdir(".cache", { recursive: true });

let fork: Awaited<ReturnType<typeof startChainFork>>;
try { fork = await startChainFork(upstreamUrl, CHAIN_ID, EXECUTION_CHAIN_ID, { finalityLagBlocks: FINALITY_LAG_BLOCKS }); }
catch (error) {
  const message = redact(error);
  console.error(`BLOCKED: the Robinhood fork did not start: ${message}`);
  evidence.status = isRateLimited(message) ? "blocked_rate_limited" : "failed"; evidence.error = message;
  await writeFile(FAILED_EVIDENCE, evidenceText(evidence));
  process.exit(1);
}
const forkChain = { ...robinhood, id: EXECUTION_CHAIN_ID, name: "Isolated Robinhood Chain fork" };
const client = createPublicClient({ chain: forkChain, pollingInterval: 100, transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }) });
const sdk = new DopplerSDK<4663>({
  chainId: CHAIN_ID,
  publicClient: createPublicClient({ chain: robinhood,
    transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }),
  }).extend(() => ({ getChainId: async () => CHAIN_ID })),
});
const scratch = await mkdtemp(join(tmpdir(), "musegod-robinhood-fork-"));
const sharesAbi = parseAbi(["function getShares(bytes32 poolId,address beneficiary) view returns(uint256)"]);
const wethAbi = parseAbi(["function deposit() payable"]);
const stockAbi = parseAbi(["function uiMultiplier() view returns(uint256)", "function paused() view returns(bool)"]);
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const balance = (asset: Address, account: Address) => client.readContract({
  address: asset, abi: erc20Abi, functionName: "balanceOf", args: [account],
});
const code = async (address: Address) => (await client.getCode({ address })) ?? "0x";
async function confirmed(hash: Hash) {
  await fork.rpcCall("anvil_mine", [2]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const transaction = await client.getTransaction({ hash });
    const trace = await fork.rpcCall("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
    await writeFile(".cache/robinhood-reverted-transaction.json", JSON.stringify({ receipt, transaction, trace }, serialize, 2) + "\n");
    throw new Error(`Local fork transaction reverted: ${hash}; gas used ${receipt.gasUsed} of ${transaction.gas}; see .cache/robinhood-reverted-transaction.json`);
  }
  return receipt;
}
// Fresh random creator only: Anvil's default accounts are live on Robinhood mainnet and at least one carries an EIP-7702 delegation.
async function freshActor() {
  const address = privateKeyToAddress(generatePrivateKey());
  assert.equal(await code(address), "0x", "A fresh actor must have no code");
  await fork.rpcCall("anvil_setBalance", [address, toHex(parseEther("100"))]);
  await fork.rpcCall("anvil_impersonateAccount", [address]);
  return address;
}
async function impersonate(account: Address) {
  if (await client.getBalance({ address: account }) < parseEther("1")) await fork.rpcCall("anvil_setBalance", [account, toHex(parseEther("10"))]);
  await fork.rpcCall("anvil_impersonateAccount", [account]);
}

// The production service class with one test override: the opening valuation (LI.FI) is synthetic. Everything else, including the
// fee-engine verification, prepare, validateLaunch, register and recovery, is the production code path.
class ForkLaunchpadService extends LaunchpadService {
  override async openingValuation(quoteAddress: Address) {
    const asset = ROBINHOOD_STOCKS.find((row) => sameAddress(row.address, quoteAddress));
    const price = asset && SYNTHETIC_PRICE_USD[asset.ticker];
    assert(price, `No synthetic price for ${quoteAddress}`);
    return syntheticOpeningValuation(quoteAddress, price, { chainId: CHAIN_ID });
  }
}

let snapshot: Hex | undefined;
let service: ForkLaunchpadService | undefined;
const testedTokens: Address[] = [];
try {
  assert.equal(await client.getChainId(), EXECUTION_CHAIN_ID);
  assert.match(await fork.rpcCall("web3_clientVersion") as string, /anvil/i);
  const pinned = await client.getBlock({ blockNumber: fork.blockNumber });
  Object.assign(evidence, { forkBlockNumber: fork.blockNumber, forkBlockHash: pinned.hash, forkBlockTimestamp: pinned.timestamp });
  // One upstream read, for the record only: how far the live chain's finalized block trails its head.
  const upstreamFinalized = await fork.upstream.getBlock({ blockTag: "finalized" }).catch((error: unknown) => {
    if (isRateLimited(redact(error))) throw error;
    return null;
  });
  if (upstreamFinalized?.number !== null && upstreamFinalized?.number !== undefined)
    evidence.finality.upstreamFinalizedLagAtFork = fork.blockNumber - upstreamFinalized.number;
  snapshot = await fork.rpcCall("evm_snapshot") as Hex;

  // ---------- the service: production code, an isolated SQLite store, throwaway secrets ----------
  const runtime = runtimeFromEnv(undefined, {
    NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: String(CHAIN_ID), FORK_RPC_URL: fork.rpc, DATA_DIR: join(scratch, "store"),
    PLATFORM_TREASURY: OPERATIONS_TREASURY, FEE_ENGINE_ADDRESS: ENGINE,
    PLAN_ATTESTATION_KEY: randomBytes(32).toString("hex"), LIFI_INTEGRATOR: "musegodfun",
  });
  assert.equal(runtime.config.mode, "fork");
  assert.equal(runtime.config.deploymentChainId, CHAIN_ID);
  // The fork keeps chain id 4663 (see the header); the service still checks this against the RPC and requires Anvil (assertNetwork).
  runtime.config.chainId = EXECUTION_CHAIN_ID;
  const contracts = contractsFor(runtime.config);
  evidence.contracts = contracts;
  service = new ForkLaunchpadService(runtime);
  // The public configuration names the engine only after verifyFeeEngine accepted its whole fixed graph and recorded activation against
  // the fork's state, and its operations treasury equals the configured treasury. That check swallows its reason, so a failure asks
  // verifyFeeEngine once more, only to report why.
  const live = await service.config(true);
  if (!live.feeEngine) {
    const reason = await verifyFeeEngine(service.client, ENGINE, undefined, { identityStore: service.store })
      .then(() => "verifyFeeEngine passed, so the configured treasury does not match the engine's operations treasury", redact);
    throw new Error(`The fee engine did not verify on the fork: ${reason}`);
  }
  assert.equal(live.feePolicy, ENGINE_FEE_POLICY);
  assert(sameAddress(live.feeEngine, ENGINE), "The verified fee engine is not the manifest's engine");
  assert(live.treasury && sameAddress(live.treasury, OPERATIONS_TREASURY));
  assert.equal(live.writesEnabled, true);
  const graph = await verifyFeeEngine(service.client, ENGINE, undefined, { identityStore: service.store });
  assert(sameAddress(graph.engine, ENGINE) && sameAddress(graph.operationsTreasury, OPERATIONS_TREASURY));
  evidence.feeEngine = {
    candidate: ENGINE, operationsTreasury: OPERATIONS_TREASURY,
    verifiedBy: "LaunchpadService.config(true) -> verifyFeeEngine (server/buyback-engine.ts), the production path; plus one direct verifyFeeEngine call for this record",
    config: { feePolicy: live.feePolicy, feeEngine: live.feeEngine, treasury: live.treasury, buybackExecutor: live.buybackExecutor,
      automationReceiver: live.automationReceiver, automationTreasury: live.automationTreasury, wethForwarder: live.wethForwarder,
      assetFeedOracle: live.assetFeedOracle, buybackVault: live.buybackVault },
    graph: { blockNumber: graph.blockNumber, engine: graph.engine, swapper: graph.swapper, executor: graph.executor, oracle: graph.oracle,
      assetOracle: graph.assetOracle, forwarder: graph.forwarder, vault: graph.vault, sourceDeployed: graph.sourceDeployed,
      activation: { fingerprint: graph.activation.fingerprint, activatedAtBlock: graph.activation.activatedAtBlock } },
  };

  // ---------- actors ----------
  const creator = await freshActor();
  const treasury = OPERATIONS_TREASURY;
  await impersonate(treasury);
  evidence.actors = { creator, creatorKind: "fresh random address, impersonated on the fork", treasury,
    treasuryKind: "the engine manifest's operations treasury, impersonated on the fork only to claim its fees", treasuryCodeLength: ((await code(treasury)).length - 2) / 2 };
  const wallet = createWalletClient({ chain: forkChain, account: creator, transport: http(fork.rpc) });
  const treasuryWallet = createWalletClient({ chain: forkChain, account: treasury, transport: http(fork.rpc) });

  /** A real holder of `token` with at least `amount`, checked with balanceOf and a simulated transfer to the creator. First the
   * Uniswap v4 PoolManager (it holds every v4 pool's reserves and funded every asset of the earlier fork evidence), then the parties of
   * recent Transfer logs: one upstream getLogs per 10-block window, newest first, at most 10 windows and 25 new parties per window. It
   * stops at the first donor. A 429, or a refused window, stops the run. */
  async function findDonor(token: Address, amount: bigint) {
    const head = fork.blockNumber, candidatesTried: Record<string, unknown>[] = [], windowsScanned: Record<string, unknown>[] = [];
    const seen = new Set([creator, treasury].map((address) => address.toLowerCase()));
    async function usable(candidate: Address, source: string) {
      seen.add(candidate.toLowerCase());
      const held = await balance(token, candidate);
      let simulated = false;
      if (held >= amount) simulated = await client.simulateContract({ address: token, abi: erc20Abi, functionName: "transfer",
        args: [creator, amount], account: candidate }).then(() => true, () => false);
      candidatesTried.push({ candidate, source, balance: held, transferSimulated: simulated });
      return simulated ? held : null;
    }
    const found = (donor: Address, donorBefore: bigint) => ({ donor, donorBefore, candidatesTried, windowsScanned });
    const known = await usable(contracts.poolManager, "known holder: Uniswap v4 PoolManager");
    if (known !== null) return found(contracts.poolManager, known);
    for (let window = 0n; window < 10n; window++) {
      const toBlock = head - window * 10n, fromBlock = toBlock - 9n;
      let logs;
      try { logs = await fork.upstream.getLogs({ address: token, event: transferEvent, fromBlock, toBlock, strict: true }); }
      catch (error) {
        const message = redact(error);
        windowsScanned.push({ fromBlock, toBlock, refused: true });
        throw Object.assign(new Error(isRateLimited(message) ? `Upstream rate limit during the Transfer-log scan: ${message}`
          : `The Transfer-log scan was refused for blocks ${fromBlock}-${toBlock}: ${message}`), { blocked: true, candidatesTried, windowsScanned });
      }
      const parties = [...new Set(logs.flatMap((log) => [log.args.to, log.args.from])
        .filter((address): address is Address => !!address && !sameAddress(address, zeroAddress)).map((address) => getAddress(address)))]
        .filter((address) => !seen.has(address.toLowerCase())).slice(0, 25);
      windowsScanned.push({ fromBlock, toBlock, logs: logs.length, newParties: parties.length });
      for (const candidate of parties) {
        const held = await usable(candidate, `Transfer log, blocks ${fromBlock}-${toBlock}`);
        if (held !== null) return found(candidate, held);
      }
    }
    throw Object.assign(new Error(`No holder with at least ${amount} raw units of ${token} among the PoolManager and 10 recent 10-block windows`),
      { blocked: true, candidatesTried, windowsScanned });
  }
  async function fundAsset(asset: typeof ROBINHOOD_STOCKS[number], amount: bigint) {
    if (asset.symbol === "WETH") {
      const before = await balance(asset.address, creator);
      const receipt = await confirmed(await wallet.writeContract({
        address: asset.address, abi: wethAbi, functionName: "deposit", value: amount,
      }));
      assert.equal(await balance(asset.address, creator) - before, amount);
      return { kind: "real_WETH_deposit_on_local_fork", hash: receipt.transactionHash, amount };
    }
    // Existing inventory, never a fabricated token balance or replacement contract.
    // Impersonation is available only on this isolated loopback fork.
    const found = await findDonor(asset.address, amount);
    await impersonate(found.donor);
    try {
      const donorWallet = createWalletClient({ chain: forkChain, account: found.donor, transport: http(fork.rpc) });
      const before = await balance(asset.address, creator);
      const receipt = await confirmed(await donorWallet.writeContract({ address: asset.address,
        abi: erc20Abi, functionName: "transfer", args: [creator, amount] }));
      assert.equal(await balance(asset.address, creator) - before, amount);
      assert.equal(found.donorBefore - await balance(asset.address, found.donor), amount);
      return { kind: "verified_existing_inventory_transfer_on_local_fork", ...found, hash: receipt.transactionHash, amount };
    } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [found.donor]); }
  }

  for (const ticker of testedTickers) {
    evidence.stage = ticker;
    const asset = ROBINHOOD_STOCKS.find((row) => row.ticker === ticker);
    assert(asset, `Curated whitelist must contain ${ticker}`);
    console.log(`Robinhood fork: ${ticker} create / register / buy / sell / both beneficiaries' fees`);
    if (ticker === "NVDA") {
      assert.equal(await client.readContract({ address: asset.address, abi: stockAbi, functionName: "paused" }), false);
      assert((await client.readContract({ address: asset.address, abi: stockAbi, functionName: "uiMultiplier" })) > 0n);
    }
    const amount = parseUnits(["USDG", "MUSEGOD"].includes(ticker) ? "20" : "0.02", asset.decimals);
    const funding = await fundAsset(asset, amount);
    const plan = await service.prepare({
      name: `Robinhood ${ticker} Fork Proof`, symbol: `RH${ticker.toUpperCase()}`,
      description: "Isolated local Robinhood Chain fork acceptance. No mainnet transaction.",
      image: "", quoteAddress: asset.address,
    }, creator, CURVE_POLICY);
    assert.equal(plan.feePolicy, ENGINE_FEE_POLICY);
    assert(sameAddress(plan.feeTreasury!, treasury));
    assert(plan.feeEngine && sameAddress(plan.feeEngine, ENGINE));
    assert.equal(plan.curvePolicy, CURVE_POLICY);
    // validateLaunch repeats every plan check (curve and fee policy, asset, treasury, signing window, plan integrity) and re-verifies the
    // live configuration, fee engine included, and then reaches the signing gate, which admits a fork only as chain id 31337. This fork
    // keeps 4663 for the engine's activation check (see the header), so it must stop exactly there; any other refusal fails here with its
    // own message shown. The engine comparison that follows the gate is asserted directly against a fresh configuration.
    const validation: string = await service.validateLaunch(creator, plan.data)
      .then(() => "accepted", (error: unknown) => error instanceof Error ? error.message : String(error));
    assert.equal(validation, SIGNING_NETWORK_GATE);
    const signingConfig = await service.config(true);
    assert(signingConfig.feeEngine && sameAddress(signingConfig.feeEngine, plan.feeEngine), "The plan's fee engine must equal the live verified engine");
    const launchHash = await wallet.sendTransaction({ to: contracts.airlock, data: plan.data, value: 0n });
    await service.trackLaunch(launchHash, plan.id);
    await confirmed(launchHash);
    await service.store.close();
    service = new ForkLaunchpadService(runtime);
    service.runtime.config.writesEnabled = false;
    await service.reconcile();
    assert.equal((await service.store.token(plan.tokenAddress))?.address, plan.tokenAddress,
      "Server restart recovers already submitted issuance while new signing is disabled");
    service.runtime.config.writesEnabled = true;
    const registered = await service.register(launchHash);
    testedTokens.push(registered.address);
    assert.equal((await service.register(launchHash)).address, registered.address);
    assert.equal(registered.mode, "fork");
    assert.equal(registered.feePolicy, ENGINE_FEE_POLICY);
    assert(registered.feeEngine && sameAddress(registered.feeEngine, ENGINE));
    assert.equal(registered.openingValuation?.policy, OPENING_POLICY);
    assert.equal(registered.openingValuation.marketCapUsd, OPENING_CAP_USD);
    assert.equal(registered.openingValuation.quotePriceUsd, SYNTHETIC_PRICE_USD[ticker]);
    const pool = await sdk.getMulticurvePool(registered.address);
    const state = await pool.getState();
    assert.equal(state.status, 2);
    assert.equal(state.poolKey.fee, 8388608);
    assert(sameAddress(state.numeraire, asset.address));
    assert(sameAddress(state.poolKey.hooks, contracts.initializer));
    assert.equal((await service.state(registered.address)).token.poolId, plan.poolId);
    assert.equal(await client.readContract({ address: registered.address, abi: erc20Abi, functionName: "totalSupply" }), SUPPLY);
    // Uniswap v4 StateLibrary: pools mapping is storage slot 6; Slot0's
    // low 160 bits contain sqrtPriceX96. Read the actual new pool before buys.
    const priceBlock = await client.getBlockNumber();
    const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [registered.poolId, 6n]));
    const slot0 = await client.readContract({ address: contracts.poolManager,
      abi: parseAbi(["function extsload(bytes32 slot) view returns(bytes32)"]),
      functionName: "extsload", args: [slot], blockNumber: priceBlock });
    const sqrtPriceX96 = BigInt(slot0) & ((1n << 160n) - 1n);
    assert(sqrtPriceX96 > 0n);
    const memeIs0 = sameAddress(state.poolKey.currency0, registered.address);
    const squared = sqrtPriceX96 * sqrtPriceX96, q192 = 1n << 192n;
    const numerator = (memeIs0 ? squared : q192) * 10n ** 18n;
    const denominator = (memeIs0 ? q192 : squared) * 10n ** BigInt(asset.decimals);
    const actualOpeningCapUsd = Number(numerator) / Number(denominator)
      * Number(registered.openingValuation.quotePriceUsd) * 1_000_000_000;
    assert(Math.abs(actualOpeningCapUsd / OPENING_CAP_USD - 1) <= 1.0001 ** 10 - 1 + 1e-8,
      `${ticker}: initial pool valuation ${actualOpeningCapUsd} exceeds tickSpacing=10 rounding tolerance`);
    const owner = await sdk.getAirlockOwner();
    const readShare = (contract: Address, account: Address) => client.readContract({
      address: contract, abi: sharesAbi, functionName: "getShares", args: [registered.poolId, account],
    });
    const shares = {
      initializer: { protocolOwner: await readShare(contracts.initializer, owner), creator: await readShare(contracts.initializer, creator),
        treasury: await readShare(contracts.initializer, treasury), engine: await readShare(contracts.initializer, ENGINE) },
      rehype: { creator: await readShare(contracts.rehype, creator), treasury: await readShare(contracts.rehype, treasury),
        engine: await readShare(contracts.rehype, ENGINE) },
    };
    assert.deepEqual(shares, expectedShares, `${ticker}: on-chain beneficiary shares must follow ENGINE_FEE_POLICY`);
    async function trade(currencyIn: Address, amountIn: bigint) {
      const side = sameAddress(currencyIn, asset!.address) ? "buy" : "sell";
      const quote = await service!.quote(registered.address, side,
        formatUnits(amountIn, side === "buy" ? asset!.decimals : 18), 100);
      const deadline = (await client.getBlock()).timestamp + 300n;
      if ((await client.readContract({ address: currencyIn, abi: erc20Abi,
        functionName: "allowance", args: [creator, contracts.permit2] })) < amountIn)
        await confirmed(await wallet.writeContract({ address: currencyIn, abi: erc20Abi,
          functionName: "approve", args: [contracts.permit2, amountIn] }));
      await confirmed(await wallet.writeContract({ address: contracts.permit2, abi: permit2Abi,
        functionName: "approve", args: [currencyIn, contracts.router, amountIn, Number(deadline)] }));
      const tx = swapTransaction(state.poolKey, currencyIn, amountIn, BigInt(quote.amountOut), 100, deadline, contracts);
      try { await client.call({ account: creator, to: tx.to, data: tx.data, value: tx.value }); }
      catch (error) {
        const trace = await fork.rpcCall("debug_traceCall", [
          { from: creator, to: tx.to, data: tx.data, value: toHex(tx.value) }, "latest",
          { tracer: "callTracer" },
        ]);
        await writeFile(".cache/robinhood-swap-failure-trace.json", JSON.stringify({ ticker, side, tx,
          poolKey: state.poolKey, quote, trace }, serialize, 2));
        throw error;
      }
      const receipt = await confirmed(await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }));
      return { hash: receipt.transactionHash, amountIn, quotedOut: quote.amountOut, minOut: tx.minOut };
    }
    const beforeBuy = await balance(asset.address, creator);
    const buy = await trade(asset.address, amount / 2n);
    assert.equal(beforeBuy - await balance(asset.address, creator), buy.amountIn);
    const bought = await balance(registered.address, creator);
    assert(bought >= buy.minOut);
    const beforeSell = await balance(asset.address, creator);
    const sell = await trade(registered.address, bought / 2n);
    const quoteReturned = await balance(asset.address, creator) - beforeSell;
    assert(quoteReturned >= sell.minOut);
    assert.equal(bought - await balance(registered.address, creator), sell.amountIn);
    const claimData = encodeFunctionData({ abi: claimFeesAbi, functionName: "collectFees", args: [registered.poolId] });
    const assetIs0 = sameAddress(state.poolKey.currency0, asset.address);
    const ordered = (fees: { fees0: bigint; fees1: bigint }) => assetIs0
      ? [fees.fees0, fees.fees1] : [fees.fees1, fees.fees0];
    const payouts = [];
    for (const [account, signer] of [[creator, wallet], [treasury, treasuryWallet]] as const) {
      const preview = await service.fees(registered.address, account);
      let totalQuote = 0n;
      for (const [kind, contract, fees] of [["hook", contracts.rehype, preview.trade],
        ["LP", contracts.initializer, preview.lp]] as const) {
        const before = await Promise.all([balance(asset.address, account), balance(registered.address, account)]);
        await client.call({ account, to: contract, data: claimData });
        // MUSEGOD's transfer callback performs additional oracle/state reads.
        // A traced local receipt exhausted nested-call gas at Anvil's exact
        // estimate. Keep a measured margin; contract balances/claims still
        // must match the preview exactly, without modifying token state.
        const estimatedGas = await client.estimateGas({ account, to: contract, data: claimData });
        const gasLimit = estimatedGas * 125n / 100n;
        const receipt = await confirmed(await signer.sendTransaction({ to: contract, data: claimData, gas: gasLimit }));
        const after: bigint[] = await Promise.all([balance(asset.address, account), balance(registered.address, account)]);
        const paid: bigint[] = after.map((amount: bigint, index: number) => amount - before[index]);
        assert.deepEqual(paid, ordered(fees), `${ticker} ${kind} preview must equal each raw currency payout`);
        totalQuote += paid[0];
        // Engine receipts are split on-chain, so the operations treasury's income is all operations: no second 80/20 split.
        const allocation = account === treasury ? paid.map((amount) =>
          allocateFeeIncome({ feePolicy: ENGINE_FEE_POLICY, amount, account, creator, treasury, engine: ENGINE })!) : undefined;
        if (allocation) allocation.forEach((row, index) =>
          assert.deepEqual(row, { creator: 0n, platform: paid[index], buyback: 0n, operations: paid[index], remainder: 0n }));
        payouts.push({ account, kind, hash: receipt.transactionHash, estimatedGas, gasLimit,
          gasUsed: receipt.gasUsed, currencies: [asset.symbol, registered.symbol], paid,
          platformAllocationReferenceOnly: allocation });
      }
      assert(totalQuote > 0n, `${ticker} beneficiary must actually receive quote fees`);
    }
    // The engine's own claim belongs to the buyback flow (not run here); its accrued share is read only.
    const enginePreview = await service.fees(registered.address, ENGINE);
    const engineFees = { lp: ordered(enginePreview.lp), hook: ordered(enginePreview.trade), currencies: [asset.symbol, registered.symbol] };
    assert([...engineFees.lp, ...engineFees.hook].some((amount) => amount > 0n), `${ticker}: the fee engine must accrue its share`);
    evidence.assets.push({ asset: { ticker: asset.ticker, symbol: asset.symbol, address: asset.address, decimals: asset.decimals },
      funding, tokenAddress: registered.address, poolId: registered.poolId, planId: plan.id, launchHash,
      feePolicy: registered.feePolicy, feeTreasury: registered.feeTreasury, feeEngine: registered.feeEngine,
      validateLaunch: { result: validation, meaning: "every check before the signing gate passed; refused only at the gate (fork chain id 4663)" },
      openingValuation: { kind: "synthetic", policy: registered.openingValuation.policy, marketCapUsd: registered.openingValuation.marketCapUsd,
        quotePriceUsd: registered.openingValuation.quotePriceUsd },
      initialPoolPrice: { blockNumber: priceBlock, sqrtPriceX96, memeIs0, actualOpeningCapUsd },
      shares, buy, sell, bought, quoteReturned, payouts, engineAccruedFeesPreview: engineFees,
      checks: ["fee engine verified through the production config path", "canonical creation with ENGINE_FEE_POLICY",
        "validateLaunch passes every check up to the signing gate", "plan fee engine equals the live verified engine", "registration and idempotency", "restart recovery",
        "pool opens at the synthetic opening valuation", "buy and sell exact raw unit balances", "onchain ENGINE_FEE_POLICY beneficiary shares",
        "separate hook and LP claim preview/receipt/balance equality for creator and operations treasury", "fee engine accrues its share"] });
    console.log(`PASS: ${ticker} ${asset.decimals}-decimal quote complete`);
  }
  evidence.fullFlowPassed = evidence.assets.length === testedTickers.length;
  assert(evidence.fullFlowPassed, "All representative quote precisions, stock and custom asset flows must pass");
  evidence.status = "passed";
  evidence.stage = "cleanup";
} catch (error) {
  const message = redact(error);
  evidence.error = message;
  const blocked = !!(error as { blocked?: boolean })?.blocked;
  // A donor search that found nobody still records what it tried.
  const scan = error as { candidatesTried?: unknown; windowsScanned?: unknown };
  if (scan?.candidatesTried) Object.assign(evidence, { donorSearch: { candidatesTried: scan.candidatesTried, windowsScanned: scan.windowsScanned } });
  evidence.status = isRateLimited(message) ? "blocked_rate_limited" : blocked ? "blocked" : "failed";
  console.error(`${evidence.status.toUpperCase()} at ${evidence.stage}: ${message}`);
} finally {
  try {
    const svc = service;
    if (snapshot && svc && testedTokens.length) {
      // Precondition of the reorganization check: no tested launch is final, so reconcile still owes it a re-check.
      const finalizedHead = (await client.getBlock({ blockTag: "finalized" })).number;
      const launchBlocks = await Promise.all(testedTokens.map(async (address) => BigInt((await svc.store.token(address))?.blockNumber ?? "0")));
      const lowest = launchBlocks.reduce((low, block) => block < low ? block : low);
      Object.assign(evidence.finality, { finalizedHeadBeforeRevert: finalizedHead, lowestLaunchBlock: lowest });
    }
    if (snapshot) {
      evidence.snapshotRestored = await fork.rpcCall("evm_revert", [snapshot]) as boolean;
      assert.equal(evidence.snapshotRestored, true);
    }
    const { finalizedHeadBeforeRevert, lowestLaunchBlock } = evidence.finality;
    if (lowestLaunchBlock !== null)
      assert(lowestLaunchBlock > 0n && finalizedHeadBeforeRevert !== null && finalizedHeadBeforeRevert < lowestLaunchBlock,
        "A tested launch was already final before the chain reorganized");
    if (svc && testedTokens.length) {
      // Production maintenance: each reconcile re-checks the launches that are due; a confirmed one is due again within 60 seconds.
      const started = Date.now();
      let rounds = 0, remaining: Address[] = testedTokens;
      for (;;) {
        await svc.reconcile();
        rounds++;
        remaining = (await Promise.all(testedTokens.map(async (address) => await svc.store.token(address) ? address : null)))
          .filter((address): address is Address => !!address);
        if (!remaining.length || Date.now() - started >= ORPHAN_CLEANUP_MAX_WAIT_MS) break;
        await new Promise((done) => setTimeout(done, 5_000));
      }
      evidence.orphanCleanup = { reconcileRounds: rounds, waitedMs: Date.now() - started, remaining };
      assert.deepEqual(remaining, [], "Reorganization removes orphaned issuance records");
      evidence.orphanedRecordsRemoved = true;
    }
  } catch (error) {
    const message = redact(error);
    console.error(`Cleanup failed: ${message}`);
    if (evidence.status === "passed") { evidence.status = "failed"; evidence.error = `Cleanup: ${message}`; }
  } finally {
    try { await service?.store.close(); } catch { /* already closed */ }
    evidence.blockedUpstreamWrites = fork.blockedUpstreamWrites();
    await fork.stop();
    await rm(scratch, { recursive: true, force: true });
  }
  if (evidence.blockedUpstreamWrites !== 0 && evidence.status === "passed") { evidence.status = "failed"; evidence.error = "An upstream write was attempted"; }
  if (evidence.status === "passed") evidence.stage = "completed";
  evidence.completedAt = new Date().toISOString();
  // A failed run never replaces the last passing evidence and stays out of git (.cache is ignored).
  const path = evidence.status === "passed" ? PASSED_EVIDENCE : FAILED_EVIDENCE;
  await writeFile(path, evidenceText(evidence));
  console.log(JSON.stringify({ status: evidence.status, forkBlockNumber: evidence.forkBlockNumber, evidence: path,
    assets: evidence.assets.map((row) => (row.asset as { ticker: string }).ticker) }, serialize));
}
if (evidence.status !== "passed") process.exitCode = 1;
else console.log(`PASS: Robinhood fork ${testedTickers.join(" / ")} under ${ENGINE_FEE_POLICY}; snapshot restored and no mainnet writes.`);
