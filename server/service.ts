import {
  DopplerSDK,
  airlockAbi,
  bundlerAbi,
  computePoolId,
  rehypeDopplerHookInitializerAbi,
  verifyPreparedCreateExecution,
} from "@whetstone-research/doppler-sdk/evm";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import {
  contractsFor,
  assetsFor,
  launchAssetsFor,
  deploymentChain,
  networkName,
  listedTokens,
  quoteAsset,
  poolCurrency,
  SUPPLY,
  sameAddress,
  stockByAddress,
  type RuntimeConfig,
  type StockStatus,
  type TokenRecord,
  type ContractRegistry,
} from "../src/lib/config";
import { assertStock, buildLaunch } from "../src/lib/protocol";
import { ENGINE_FEE_POLICY, launchFeePolicy } from "../src/lib/fee-policy";
import { tradingFeeBpsFor } from "../src/lib/trading-fee";
import { assertOpeningValuation, assertHistoricalOpeningValuation, openingCapInQuote, LAUNCH_PRICE_TTL } from "../src/lib/opening-valuation";
import { readOpeningValuation } from "./opening-price";
import {
  addressSchema,
  launchSchema,
  parseAmount,
  minimumOutput,
  errorMessage,
  simulationError,
} from "../src/lib/validation";
import { SupabaseStore, type StoreBackend } from "./supabase-store";
import { z } from "zod";
import { Store, type LaunchPlan } from "./store";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { launchGuardAbi } from "../src/lib/launch-guard";
import { restorePrepared, serializePrepared, type FirstBuyLockStatus } from "../src/lib/launch-plan";
import { chainLaunchDependencies, verifyLaunchGuard } from "./launch-guard";
import { assertLaunchTradingFee, assertPlanIntegrity, verifiedFirstBuyLock, verifyGuardedReceipt } from "./launch-verification";
import { verifyFeeEngine } from "./buyback-engine";
import type { EngineClaimPreview } from "../src/lib/buyback-engine";

import { runtimeFromEnv, redact } from "./config";
export { runtimeFromEnv } from "./config";
export class LaunchpadService {
  readonly client;
  readonly sdk;
  get contracts() { return contractsFor(this.runtime.config); }
  get assets() { return assetsFor(this.runtime.config); }
  readonly store: StoreBackend;
  private readonly guardCandidate: Address | null;
  private readonly firstBuyGuardCandidate: Address | null;
  private readonly feeEngineCandidate: Address | null;
  private stocksCache?: { at: number; value: StockStatus[] };
  private stocksPromise?: Promise<StockStatus[]>;
  constructor(readonly runtime: ReturnType<typeof runtimeFromEnv>) {
    this.guardCandidate = runtime.launchGuardCandidate;
    this.firstBuyGuardCandidate = runtime.firstBuyGuardCandidate;
    this.feeEngineCandidate = runtime.config.feeEngine ?? null;
    const chainId = deploymentChain(runtime.config);
    this.client = createPublicClient({
      chain: { ...base, id: runtime.config.chainId, name: networkName(runtime.config) },
      transport: http(runtime.rpcUrl, {
        timeout: runtime.config.mode === "fork" ? 180_000 : 25_000,
        retryCount: 0,
      }),
      batch: { multicall: true },
    });
    // SDK entities query chainId for their address registry. Only after the runtime
    // guards identify a local fork do they use Base's immutable deployment map.
    const sdkClient =
      runtime.config.mode === "fork"
        ? this.client.extend(() => ({ getChainId: async () => chainId }))
        : this.client;
    this.sdk = new DopplerSDK<8453 | 4663>({
      publicClient: { ...sdkClient, chain: { ...base, id: chainId, name: networkName({ mode: chainId === 4663 ? "robinhood" : "base" }) } }, chainId,
    });
    this.store =
      runtime.config.mode !== "fork" && runtime.supabase
        ? new SupabaseStore(
            runtime.supabase.url,
            runtime.supabase.secretKey,
            runtime.dataScope,
            "base",
          )
        : new Store(runtime.dataDir, runtime.config.chainId);
  }
  async assertNetwork() {
    if ((await this.client.getChainId()) !== this.runtime.config.chainId)
      throw new Error("RPC network does not match the platform configuration. Processing stopped.");
    if (this.runtime.config.mode === "fork") {
      const body = await this.rpcRequest("web3_clientVersion", []);
      if (!/anvil/i.test(String(body)))
        throw new Error("Fork mode requires a local Anvil node.");
    }
  }
  async rpcRequest(method: string, params: unknown[]) {
    const response = await fetch(this.runtime.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? "Alchemy denied access. Check the application network and access policy."
          : "Chain RPC is temporarily unavailable",
      );
    const body = await response.json() as { error?: { message?: string }; result?: unknown };
    if (body.error) throw new Error(body.error.message || "RPC request failed");
    return body.result;
  }
  async stocks(): Promise<StockStatus[]> {
    if (this.stocksCache && Date.now() - this.stocksCache.at < 300_000)
      return this.stocksCache.value;
    if (this.stocksPromise) return this.stocksPromise;
    this.stocksPromise = (async () => {
      await this.assertNetwork();
      const block = await this.client.getBlockNumber({ cacheTime: 0 });
      const statuses: StockStatus[] = [];
      for (let i = 0; i < this.assets.length; i += 6)
        statuses.push(
          ...(await Promise.all(
            this.assets.slice(i, i + 6).map(async (stock) => {
              try {
                const result = await assertStock(
                  this.client,
                  stock.address,
                  block,
                );
                return {
                  ...stock,
                  verified: true,
                  blockNumber: String(block),
                  onchainName: result.name,
                  totalSupply: result.totalSupply.toString(),
                  multiplierWad: result.multiplierWad?.toString() ?? null,
                };
              } catch (error) {
                return {
                  ...stock,
                  verified: false,
                  blockNumber: String(block),
                  totalSupply: null,
                  multiplierWad: null,
                  error: `Asset read or identity verification failed. Try refreshing later. ${redact(error)}`,
                };
              }
            }),
          )),
        );
      if (statuses.every((s) => s.verified))
        this.stocksCache = { at: Date.now(), value: statuses };
      return statuses;
    })();
    try {
      return await this.stocksPromise;
    } finally {
      this.stocksPromise = undefined;
    }
  }
  async config(): Promise<RuntimeConfig> {
    // Fail closed for first buys, while ordinary issuance and receipt recovery
    // remain available when a guard is missing or temporarily unverifiable.
    let launchGuard: Address | null = null;
    let launchLockAvailable = false;
    let feeEngine: Address | null = null;
    let buybackExecutor: Address | null = null;
    let automationReceiver: Address | null = null;
    let automationTreasury: Address | null = null;
    let wethForwarder: Address | null = null;
    for (const candidate of [
      { address: this.firstBuyGuardCandidate, requiredVersion: "vesting" as const },
      { address: this.guardCandidate, requiredVersion: undefined },
    ]) {
      if (!candidate.address || launchGuard) continue;
      try {
        await this.assertNetwork();
        const verified = await verifyLaunchGuard(this.client, candidate.address, deploymentChain(this.runtime.config), candidate.requiredVersion);
        launchGuard = candidate.address;
        launchLockAvailable = verified.supportsLock;
      } catch { /* The public configuration exposes only a verified address. */ }
    }
    if (this.feeEngineCandidate && deploymentChain(this.runtime.config) === 4663) {
      try {
        await this.assertNetwork();
        const verified = await verifyFeeEngine(this.client, this.feeEngineCandidate);
        if (this.runtime.config.treasury && sameAddress(this.runtime.config.treasury, verified.operationsTreasury)) {
          automationReceiver = verified.automationReceiver;
          automationTreasury = verified.automationTreasury;
          wethForwarder = verified.forwarder;
          if (verified.sourceDeployed && BigInt(verified.sourceAllowance) > 0n) {
            feeEngine = verified.engine;
            buybackExecutor = verified.executor;
          }
        }
      } catch { /* Candidate addresses are not exposed until the complete fixed graph is verified. */ }
    }
    return { ...this.runtime.config, curvePolicy: CURVE_POLICY, launchGuard, launchLockAvailable, feeEngine, buybackExecutor, automationReceiver, automationTreasury, wethForwarder };
  }
  async preflightFirstBuyPayment(rawQuoteAddress: unknown): Promise<void> {
    const quoteAddress = addressSchema.parse(rawQuoteAddress);
    if (!this.runtime.config.treasury) throw new Error("The platform treasury is not configured.");
    if (!launchAssetsFor(this.runtime.config).some((asset) => sameAddress(asset.address, quoteAddress)))
      throw new Error("This asset is unavailable for a new launch because it is not in the verified LI.FI opening-price pairing list.");
    await this.assertNetwork();
    const config = await this.config();
    if (launchFeePolicy(config) === ENGINE_FEE_POLICY && !config.feeEngine)
      throw new Error("The configured fee engine could not be verified. Try again after deployment verification.");
    if (!config.launchGuard)
      throw new Error("Atomic first buys are unavailable until the launch guard is configured and verified.");
    await assertStock(this.client, quoteAddress);
    const chainId = deploymentChain(this.runtime.config);
    // Conversion precedes launch, so reject already-known blockers before the
    // separate payment. This does not prepare or persist a launch snapshot.
    await readOpeningValuation(this.client, stockByAddress(quoteAddress, chainId), chainId,
      { ...this.runtime.lifi, rpcChainId: this.runtime.config.mode === "fork" && this.runtime.config.chainId === 31337 ? 31337 : chainId });
  }
  async prepare(raw: unknown, rawCreator: unknown, expectedCurvePolicy?: unknown, firstBuy?: unknown): Promise<LaunchPlan> {
    // This handshake must run before any RPC, including chain checks.
    if (expectedCurvePolicy !== CURVE_POLICY)
      throw new Error("The issuance curve policy has changed. Reload the launch page and run a new preview.");
    const draft = launchSchema.parse(raw), creator = addressSchema.parse(rawCreator),
      treasury = this.runtime.config.treasury;
    if (!treasury) throw new Error("The platform treasury is not configured.");
    if (!launchAssetsFor(this.runtime.config).some((asset) => sameAddress(asset.address, draft.quoteAddress)))
      throw new Error("This asset is unavailable for a new launch because it is not in the verified LI.FI opening-price pairing list.");
    const stock = stockByAddress(draft.quoteAddress);
    const buy = firstBuySchema.parse(firstBuy);
    const amountIn = buy && !/^0(?:\.0+)?$/.test(buy.amount) ? parseAmount(buy.amount, stock.decimals) : 0n;
    if (buy?.lockDays && amountIn === 0n) throw new Error("A locked first buy requires a positive amount.");
    await this.assertNetwork();
    const launchConfig = await this.config();
    const feePolicy = launchFeePolicy(launchConfig);
    if (feePolicy === ENGINE_FEE_POLICY && !launchConfig.feeEngine)
      throw new Error("The configured fee engine could not be verified. Try again after deployment verification.");
    let guard: Address | null = null;
    if (amountIn > 0n) {
      guard = launchConfig.launchGuard ?? null;
      if (!guard) throw new Error("Atomic first buys are unavailable until the launch guard is configured and verified.");
      if (buy?.lockDays && !launchConfig.launchLockAvailable)
        throw new Error("First buy locking is unavailable until the vesting launch guard is deployed and verified on this network.");
    }
    await assertStock(this.client, draft.quoteAddress);
    const chainId = deploymentChain(this.runtime.config);
    const openingValuation = await readOpeningValuation(this.client, stock, chainId,
      { ...this.runtime.lifi, rpcChainId: this.runtime.config.mode === "fork" && this.runtime.config.chainId === 31337 ? 31337 : chainId });
    const protocolOwner = await this.sdk.getAirlockOwner();
    const params = buildLaunch(this.sdk, draft, creator, treasury, protocolOwner, openingValuation, undefined, chainId, launchConfig.feeEngine ?? undefined);
    if (amountIn > 0n) {
      params.modules = { ...params.modules, bundler: chainLaunchDependencies(chainId).bundler };
      const duration = BigInt(buy?.lockDays ?? 0) * 86400n;
      params.devBuy = { exactAmountIn: amountIn, recipient: creator,
        vesting: { permissionlessClaim: false, vestingDuration: duration, cliffDuration: duration } };
    }
    const prepared = await this.sdk.factory.prepareCreateMulticurve(params, { account: creator })
      .catch((error: unknown) => { throw simulationError(error); });
    const { prediction } = prepared;
    let firstBuyPlan: LaunchPlan["firstBuy"], approval: LaunchPlan["approval"];
    let gas = prepared.gasEstimate.status === "estimated" ? prepared.gasEstimate.gas.toString() : null;
    if (amountIn > 0n && guard && buy && prepared.devBuy) {
      const expectedAmountOut = prepared.devBuy.simulatedAmountOut;
      const minAmountOut = minimumOutput(expectedAmountOut, buy.slippageBps);
      const deadline = Math.floor(openingValuation.expiresAt / 1000);
      firstBuyPlan = { amount: buy.amount, amountIn: String(amountIn), expectedAmountOut: String(expectedAmountOut),
        minAmountOut: String(minAmountOut), slippageBps: buy.slippageBps, deadline, recipient: creator,
        quoteAddress: stock.address, guard, bundler: chainLaunchDependencies(chainId).bundler, lockDays: buy.lockDays };
      prepared.transaction = { to: guard, data: buy.lockDays ? encodeFunctionData({ abi: launchGuardAbi,
        functionName: "createAndBuyLocked", args: [prepared.createParams, amountIn, minAmountOut, BigInt(deadline), buy.lockDays] })
        : encodeFunctionData({ abi: launchGuardAbi,
          functionName: "createAndBuy", args: [prepared.createParams, amountIn, minAmountOut, BigInt(deadline)] }), value: 0n };
      const approvalTx = { to: stock.address, data: encodeFunctionData({ abi: erc20Abi,
        functionName: "approve", args: [guard, amountIn] }), value: 0n };
      const allowance = await this.client.readContract({ address: stock.address, abi: erc20Abi,
        functionName: "allowance", args: [creator, guard] });
      // The original SDK approval targets Bundler. Replace it in the persisted
      // snapshot so no caller can accidentally sign an unprotected path.
      prepared.approvalTransaction = approvalTx;
      prepared.gasEstimate = { status: "unavailable" };
      gas = null;
      approval = { token: stock.address, spender: guard, amount: String(amountIn), required: allowance < amountIn,
        transaction: { ...approvalTx, value: "0" } };
    } else if (amountIn > 0n) throw new Error("The first buy simulation did not return a valid output.");
    const transaction = { ...prepared.transaction, value: String(prepared.transaction.value) };
    const plan: LaunchPlan = {
      id: keccak256(transaction.data), creator, data: transaction.data,
      tokenAddress: prediction.tokenAddress, poolId: prediction.poolId,
      draft: { ...draft, openingCap: openingCapInQuote(openingValuation) }, preparedAt: Date.now(), gas,
      feePolicy, feeTreasury: treasury, feeEngine: launchConfig.feeEngine ?? undefined, openingValuation, curvePolicy: CURVE_POLICY,
      prepared: serializePrepared(prepared), transaction, firstBuy: firstBuyPlan, approval,
    };
    assertOpeningValuation(openingValuation, stock.address, chainId);
    assertPlanIntegrity(plan, this.contracts);
    await this.store.savePlan(plan);
    return plan;
  }
  async validateLaunch(creator: Address, data: Hex) {
    const plan = await this.store.findPlan(creator, data);
    if (!plan || plan.curvePolicy !== CURVE_POLICY)
      throw new Error("The issuance curve policy has changed. Run a new preview.");
    if (plan.feePolicy !== launchFeePolicy(this.runtime.config))
      throw new Error("The issuance fee policy has changed. Run a new simulation.");
    if (!this.assets.some((asset) => sameAddress(asset.address, plan.draft.quoteAddress)))
      throw new Error("The paired asset is no longer supported on the active network. Run a new simulation.");
    if (
      !plan.feeTreasury || !this.runtime.config.treasury ||
      !sameAddress(plan.feeTreasury, this.runtime.config.treasury) ||
      Date.now() - plan.preparedAt > LAUNCH_PRICE_TTL
    )
      throw new Error("The issuance preview expired or the treasury changed. Simulate again.");
    assertOpeningValuation(plan.openingValuation, plan.draft.quoteAddress, deploymentChain(this.runtime.config));
    assertPlanIntegrity(plan, this.contracts);
    if (plan.firstBuy || plan.feePolicy === ENGINE_FEE_POLICY) {
      const config = await this.config();
      if (plan.feePolicy === ENGINE_FEE_POLICY && (!config.feeEngine || !plan.feeEngine || !sameAddress(config.feeEngine, plan.feeEngine)))
        throw new Error("The fee engine configuration changed or could not be verified. Run a new preview.");
      if (plan.firstBuy && (!config.launchGuard || !sameAddress(config.launchGuard, plan.firstBuy.guard)))
        throw new Error("The launch guard configuration changed or could not be verified. Run a new preview.");
      if (plan.firstBuy?.lockDays && !config.launchLockAvailable)
        throw new Error("The first buy lock guard could not be verified. Run a new preview.");
    }
    return { valid: true, feePolicy: plan.feePolicy, curvePolicy: plan.curvePolicy };
  }
  async simulateLaunch(creator: Address, data: Hex) {
    await this.validateLaunch(creator, data);
    await this.assertNetwork();
    const plan = (await this.store.findPlan(creator, data))!;
    const prepared = restorePrepared(plan.prepared!);
    let amountOut: string | null = null;
    if (plan.firstBuy) {
      const buy = plan.firstBuy, amount = BigInt(buy.amountIn);
      const [balance, allowance] = await Promise.all([
        this.client.readContract({ address: buy.quoteAddress, abi: erc20Abi, functionName: "balanceOf", args: [creator] }),
        this.client.readContract({ address: buy.quoteAddress, abi: erc20Abi, functionName: "allowance", args: [creator, buy.guard] }),
      ]);
      if (balance < amount || allowance < amount) throw new Error("The first buy balance or launch guard allowance is insufficient.");
      const simulation = await this.client.simulateContract(buy.lockDays ? { address: buy.guard, abi: launchGuardAbi,
        functionName: "createAndBuyLocked", args: [prepared.createParams, amount, BigInt(buy.minAmountOut), BigInt(buy.deadline), buy.lockDays], account: creator }
        : { address: buy.guard, abi: launchGuardAbi,
          functionName: "createAndBuy", args: [prepared.createParams, amount, BigInt(buy.minAmountOut), BigInt(buy.deadline)], account: creator })
        .catch((error: unknown) => { throw simulationError(error); });
      if (!sameAddress(simulation.result[0], plan.tokenAddress) || computePoolId(simulation.result[1]) !== plan.poolId)
        throw new Error("The first buy pool identity changed. Run a new preview.");
      amountOut = String(simulation.result[4]);
      if (amountOut !== buy.expectedAmountOut)
        throw new Error("The first buy output changed. Run a new preview before signing.");
    } else {
      await this.client.call({ account: creator, to: prepared.transaction.to, data, value: 0n })
        .catch((error: unknown) => { throw simulationError(error); });
    }
    const gas = await this.client.estimateGas({ account: creator, to: prepared.transaction.to, data, value: 0n });
    // A full simulation is still unsigned evidence; the receipt is verified separately.
    await this.validateLaunch(creator, data);
    return { valid: true, gas: String(gas), amountOut, simulatedAt: Date.now() };
  }
  async trackLaunch(hash: Hex, planId: string) {
    hash = hash.toLowerCase() as Hex;
    await this.assertNetwork();
    const tx = await this.client.getTransaction({ hash });
    const plan = await this.store.findPlan(tx.from, tx.input);
    if (!plan || plan.id.toLowerCase() !== planId.toLowerCase())
      throw new Error("The transaction does not match the issuance preview and was not queued.");
    if (plan.openingValuation)
      assertHistoricalOpeningValuation(plan.openingValuation, plan.draft.quoteAddress, deploymentChain(this.runtime.config));
    assertLaunchTransaction(plan, tx, this.contracts);
    await this.store.trackLaunch(hash, plan.id);
  }
  async register(hash: Hex): Promise<TokenRecord> {
    hash = hash.toLowerCase() as Hex;
    // Receipt verification does not sign or broadcast. Keep it available when
    // signing is disabled so transactions already sent can finish registering.
    await this.assertNetwork();
    const receipt = await this.client.getTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("This creation transaction did not succeed.");
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    if (head < receipt.blockNumber + 1n)
      throw new Error("Wait for at least two block confirmations before registering.");
    const tx = await this.client.getTransaction({ hash });
    const plan = await this.store.findPlan(receipt.from, tx.input);
    if (!plan)
      throw new Error("No matching issuance preview was found. Preserve the database and original transaction hash.");
    if (plan.openingValuation)
      assertHistoricalOpeningValuation(plan.openingValuation, plan.draft.quoteAddress, deploymentChain(this.runtime.config));
    assertLaunchTransaction(plan, tx, this.contracts);
    if (!receipt.to || !sameAddress(receipt.to, plan.transaction?.to ?? this.contracts.airlock) || !sameAddress(receipt.from, plan.creator))
      throw new Error("The creation receipt does not match the preview's outer transaction.");
    if (plan.prepared) {
      const verified = await verifyPreparedCreateExecution({ prepared: restorePrepared(plan.prepared), receipt, publicClient: this.client });
      if (plan.firstBuy) verifyGuardedReceipt(plan, receipt, verified.devBuy?.amountOut);
    } else if (plan.firstBuy) throw new Error("The guarded creation snapshot is missing.");
    await this.store.trackLaunch(hash, plan.id);
    const event = receipt.logs
      .filter((l) => sameAddress(l.address, this.contracts.airlock))
      .flatMap((l) => {
        try {
          const e = decodeEventLog({
            abi: airlockAbi,
            data: l.data,
            topics: l.topics,
          });
          return e.eventName === "Create" ? [e.args] : [];
        } catch {
          return [];
        }
      })
      .find((e) => sameAddress(e.asset, plan.tokenAddress));
    if (
      !event ||
      !sameAddress(event.numeraire, plan.draft.quoteAddress) ||
      !sameAddress(event.initializer, this.contracts.initializer)
    )
      throw new Error("The creation event does not match the preview.");
    const pool = await this.sdk.getMulticurvePool(plan.tokenAddress);
    const state = await pool.getState();
    if (
      state.status !== 2 ||
      computePoolId(state.poolKey) !== plan.poolId ||
      !sameAddress(state.numeraire, plan.draft.quoteAddress)
    )
      throw new Error("The on-chain pool state does not match the preview.");
    const tradingFeeBps = tradingFeeBpsFor(plan.draft.tradingFeeBps);
    const [supply, block, feeSchedule] = await Promise.all([
      this.client.readContract({
        address: plan.tokenAddress,
        abi: erc20Abi,
        functionName: "totalSupply",
      }),
      this.client.getBlock({ blockNumber: receipt.blockNumber }),
      this.client.readContract({ address: this.contracts.rehype, abi: rehypeDopplerHookInitializerAbi,
        functionName: "getFeeSchedule", args: [plan.poolId], blockNumber: receipt.blockNumber }),
    ]);
    if (block.hash !== receipt.blockHash)
      throw new Error("The receipt block was reorganized. Wait for confirmation again.");
    if (supply !== SUPPLY) throw new Error("Supply verification failed.");
    const feePpm = tradingFeeBps * 100;
    if (feeSchedule[1] !== feePpm || feeSchedule[2] !== feePpm || feeSchedule[3] !== feePpm || feeSchedule[4] !== 0)
      throw new Error("The on-chain trading fee schedule does not match the issuance preview.");
    const firstBuyLock = verifiedFirstBuyLock(plan, receipt, block.timestamp);
    if (firstBuyLock) {
      const position = await this.client.readContract({ address: firstBuyLock.bundler, abi: bundlerAbi,
        functionName: "vestingOf", args: [plan.tokenAddress], blockNumber: receipt.blockNumber });
      if (!sameAddress(position[0], firstBuyLock.recipient) || position[1] || position[2] !== BigInt(firstBuyLock.start) ||
        position[3] !== BigInt(firstBuyLock.cliffDuration) || position[4] !== BigInt(firstBuyLock.vestingDuration) ||
        position[5] !== BigInt(firstBuyLock.totalAmount) || position[6] !== 0n)
        throw new Error("The first buy lock custody does not match its creation receipt.");
    }
    const token: TokenRecord = {
      ...plan.draft,
      tradingFeeBps,
      openingCap: plan.draft.openingCap ?? (plan.openingValuation ? openingCapInQuote(plan.openingValuation) : ""),
      address: plan.tokenAddress,
      creator: plan.creator,
      poolId: plan.poolId,
      transactionHash: hash,
      blockNumber: String(receipt.blockNumber),
      createdAt: Number(block.timestamp) * 1000,
      mode: this.runtime.config.mode,
      deploymentChainId: deploymentChain(this.runtime.config),
      feePolicy: plan.feePolicy,
      feeTreasury: plan.feeTreasury,
      feeEngine: plan.feeEngine,
      openingValuation: plan.openingValuation,
      curvePolicy: plan.curvePolicy,
      firstBuyLock,
    };
    await this.store.saveToken(token);
    await this.store.launchStatus(hash, "confirmed", receipt.blockHash);
    return token;
  }
  private reconciling = false;
  private reconcileCursor?: Hex;
  async reconcile(maxDurationMs = Infinity) {
    if (this.reconciling) return;
    this.reconciling = true;
    const deadline = Date.now() + maxDurationMs;
    try {
      await this.assertNetwork();
      const rows = await this.store.pendingLaunches();
      const cursor = rows.findIndex((row) => row.hash === this.reconcileCursor);
      const ordered = [...rows.slice(cursor + 1), ...rows.slice(0, cursor + 1)];
      for (const row of ordered) {
        // Finish each row before yielding the remaining queue to the
        // next maintenance event. RPC timeouts retain the same receipt status.
        if (Date.now() >= deadline) break;
        try {
          const token = (await this.store.tokens()).find(
            (t) => t.transactionHash?.toLowerCase() === row.hash,
          );
          if (token?.blockNumber && row.blockHash) {
            const head = await this.client.getBlockNumber({ cacheTime: 0 });
            const canonical =
              head >= BigInt(token.blockNumber)
                ? await this.client.getBlock({
                    blockNumber: BigInt(token.blockNumber),
                  })
                : null;
            if (!canonical || canonical.hash !== row.blockHash) {
              await this.store.removeToken(row.hash);
              await this.store.launchStatus(row.hash, "pending");
            }
          }
          const receipt = await this.client.getTransactionReceipt({
            hash: row.hash,
          });
          if (receipt.status === "reverted") {
            const head = await this.client.getBlockNumber({ cacheTime: 0 });
            if (head < receipt.blockNumber + 1n) continue;
            const canonical = await this.client.getBlock({ blockNumber: receipt.blockNumber });
            if (canonical.hash !== receipt.blockHash) continue;
            await this.store.removeToken(row.hash);
            await this.store.launchStatus(row.hash, "failed");
          } else await this.register(row.hash);
        } catch {
          /* Upstream absence or timeout is not evidence of failure. Retry after restart or next tick. */
        } finally {
          this.reconcileCursor = row.hash;
        }
      }
    } finally {
      this.reconciling = false;
    }
  }
  async state(address: Address) {
    await this.assertNetwork();
    const token = await this.token(address);
    const state = await (await this.sdk.getMulticurvePool(address)).getState();
    if (
      state.status !== 2 ||
      !sameAddress(state.numeraire, token.quoteAddress) ||
      computePoolId(state.poolKey) !== token.poolId
    )
      throw new Error("The pool identity or locked state is invalid");
    return { token, state };
  }
  async tokens() {
    return listedTokens(await this.store.tokens(), this.runtime.config.mode, deploymentChain(this.runtime.config));
  }
  async token(address: Address) {
    const token = await this.store.token(address);
    if (!token || !listedTokens([token], this.runtime.config.mode, deploymentChain(this.runtime.config)).length)
      throw new Error("Platform token not found");
    return token;
  }
  async quote(
    address: Address,
    side: "buy" | "sell",
    value: string,
    slippageBps: number,
  ) {
    await this.assertNetwork();
    const { token, state } = await this.state(address);
    const stock = quoteAsset(token);
    await assertStock(this.client, stock.address);
    const currencyIn = side === "buy" ? stock.address : address,
      amountIn = parseAmount(value, side === "buy" ? stock.decimals : 18);
    const quote = await this.sdk.quoter.quoteExactInputV4({
      poolKey: state.poolKey,
      zeroForOne: sameAddress(currencyIn, state.poolKey.currency0),
      exactAmount: amountIn,
      hookData: "0x",
    });
    if (quote.amountOut <= 0n)
      throw new Error("Insufficient pool liquidity for a valid quote.");
    return {
      token: address,
      side,
      amountIn: String(amountIn),
      amountOut: String(quote.amountOut),
      currencyIn,
      poolKey: state.poolKey,
      slippageBps,
      quotedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
  }
  async fees(address: Address, account: Address) {
    const { token, state } = await this.state(address);
    const pool = await this.sdk.getMulticurvePool(address),
      hook = await this.sdk.getRehypeDopplerHookInitializer(this.contracts.rehype);
    const [lp, trade] = await Promise.all([
      pool.getPendingFees(account),
      hook.getPendingFees(token.poolId, account),
    ]);
    return { lp, trade, poolKey: state.poolKey };
  }
  async firstBuyLock(address: Address): Promise<FirstBuyLockStatus | null> {
    await this.assertNetwork();
    const token = await this.token(address), record = token.firstBuyLock;
    if (!record) return null;
    const dependencies = chainLaunchDependencies(deploymentChain(this.runtime.config));
    if (!sameAddress(record.bundler, dependencies.bundler)) throw new Error("The first buy lock Bundler does not match this network.");
    const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
    const [code, position, claimable] = await Promise.all([
      this.client.getCode({ address: record.bundler, blockNumber }),
      this.client.readContract({ address: record.bundler, abi: bundlerAbi, functionName: "vestingOf", args: [address], blockNumber }),
      this.client.readContract({ address: record.bundler, abi: bundlerAbi, functionName: "claimable", args: [address], blockNumber }),
    ]);
    if (!code || keccak256(code) !== dependencies.bundlerCodeHash || !sameAddress(position[0], record.recipient) || position[1] ||
      position[2] !== BigInt(record.start) || position[3] !== BigInt(record.cliffDuration) ||
      position[4] !== BigInt(record.vestingDuration) || position[5] !== BigInt(record.totalAmount) ||
      position[6] > position[5] || claimable > position[5] - position[6])
      throw new Error("The first buy lock state does not match the verified position.");
    return { ...record, claimedAmount: String(position[6]), claimableAmount: String(claimable),
      unlockAt: record.start + record.vestingDuration,
      ...(claimable > 0n ? { claimTransaction: { to: record.bundler,
        data: encodeFunctionData({ abi: bundlerAbi, functionName: "claim", args: [address] }), value: "0" } } : {}) };
  }
  async engineClaimPreview(address: Address, engine: Address): Promise<EngineClaimPreview> {
    const { token, state } = await this.state(address);
    if (token.feePolicy !== ENGINE_FEE_POLICY || !token.feeEngine || !sameAddress(token.feeEngine, engine))
      throw new Error("This pool does not use the selected fee engine");
    const pool = await this.sdk.getMulticurvePool(address);
    const hook = await this.sdk.getRehypeDopplerHookInitializer(this.contracts.rehype);
    const [lp, trade] = await Promise.allSettled([pool.getPendingFees(engine), hook.getPendingFees(token.poolId, engine)]);
    return [state.poolKey.currency0, state.poolKey.currency1].map((currency, index) => ({
      ...poolCurrency(currency, token),
      lp: lp.status === "fulfilled" ? String(index ? lp.value.fees1 : lp.value.fees0) : null,
      hook: trade.status === "fulfilled" ? String(index ? trade.value.fees1 : trade.value.fees0) : null,
    }));
  }
}

const firstBuySchema = z.object({ amount: z.string().regex(/^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/),
  slippageBps: z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(500)]),
  lockDays: z.union([z.literal(0), z.literal(30), z.literal(90), z.literal(365)]).default(0) }).strict().optional();
function assertLaunchTransaction(plan: LaunchPlan, tx: { from: Address; to: Address | null; input: Hex; value: bigint }, contracts: ContractRegistry) {
  const target = plan.transaction?.to ?? contracts.airlock;
  if (!tx.to || !sameAddress(tx.to, target) || !sameAddress(tx.from, plan.creator) ||
      tx.input.toLowerCase() !== plan.data.toLowerCase() || tx.value !== BigInt(plan.transaction?.value ?? "0"))
    throw new Error("The outer transaction does not match the issuance preview.");
  assertLaunchTradingFee(plan, tx.input, contracts);
}
