import {
  DopplerSDK,
  airlockAbi,
  bundlerAbi,
  computePoolId,
  verifyPreparedCreateExecution,
} from "@whetstone-research/doppler-sdk/evm";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  stringToBytes,
  zeroAddress,
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
  sameAddress,
  stockByAddress,
  type RuntimeConfig,
  type StockStatus,
  type TokenRecord,
  type ContractRegistry,
} from "../src/lib/config";
import { assertStock, buildLaunch, readStockStatus as readLaunchAssetStatus } from "../src/lib/protocol";
import { firstBuyLockStatusFromPosition } from "./first-buy-lock-status";
import { ENGINE_FEE_POLICY, FEE_POLICY, launchFeePolicy } from "../src/lib/fee-policy";
import { tradingFeeBpsFor } from "../src/lib/trading-fee";
import { assertOpeningValuation, assertHistoricalOpeningValuation, openingCapInQuote, LIFI_OPENING_MAX_DIVERGENCE_BPS, type LifiOpeningValuation } from "../src/lib/opening-valuation";
import { assertRecoveredOpeningValuation, readOpeningValuation, RecoveryEvidenceError } from "./opening-price";
import {
  addressSchema,
  launchSchema,
  parseAmount,
  minimumOutput,
  errorMessage,
  simulationError,
  assertSigningEnabled,
} from "../src/lib/validation";
import { SupabaseStore, type StoreBackend } from "./supabase-store";
import { z } from "zod";
import { Store, type LaunchPlan } from "./store";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { launchGuardAbi } from "../src/lib/launch-guard";
import { assertLaunchPlanValidity, LAUNCH_SIGNING_TTL, restorePrepared, serializePrepared, type FirstBuyLockStatus, type LaunchPrepareOptions } from "../src/lib/launch-plan";
import { chainLaunchDependencies, verifyLaunchGuard } from "./launch-guard";
import { assertLaunchTradingFee, assertPlanIntegrity, assertRecoveryPlan, verifiedFirstBuyLock, verifyCreationAccounting, verifyGuardedReceipt } from "./launch-verification";
import { verifyFeeEngine } from "./buyback-engine";
import { assertTrustedLaunchPolicy, engineLaunchCutover, ENGINE_MANIFEST, trustedLaunchPolicies, type EngineLaunchCutover } from "./launch-policy-registry";
import { planAttestation, verifyPlanAttestation } from "./plan-attestation";
import { BudgetUnavailable } from "./runtime-policy";
import type { EngineClaimPreview } from "../src/lib/buyback-engine";

import { runtimeFromEnv, redact } from "./config";
export { runtimeFromEnv } from "./config";
/** The on-chain pool contradicts the stored listing; never a transient outage. */
export class PoolIdentityError extends Error {}
export class LaunchpadService {
  readonly client;
  readonly sdk;
  get contracts() { return contractsFor(this.runtime.config); }
  get assets() { return assetsFor(this.runtime.config); }
  readonly store: StoreBackend;
  private readonly guardCandidate: Address | null;
  private readonly firstBuyGuardCandidate: Address | null;
  private readonly feeEngineCandidate: Address | null;
  private stocksCache?: { at: number; ttl?: number; value: StockStatus[] };
  private stocksPromise?: Promise<StockStatus[]>;
  private guardCache?: Map<string, {at: number; value: Awaited<ReturnType<typeof verifyLaunchGuard>> | null}>;
  private guardRequests?: Map<string, Promise<Awaited<ReturnType<typeof verifyLaunchGuard>> | null>>;
  private tokensCache?: {at: number; value: TokenRecord[]};
  private tokensPromise?: Promise<TokenRecord[]>;
  private tokensRevision = 0;
  private openingCache?: Map<string, { at: number; value: LifiOpeningValuation }>;
  private openingRequests?: Map<string, Promise<LifiOpeningValuation>>;
  private registerRequests?: Map<string, Promise<TokenRecord>>;
  private stateReads?: Map<string, ReturnType<LaunchpadService["state"]>>;
  private recoveryLoad?: { active: number; started: number[] };
  private cutoverCheck?: { key: string; until: number };
  private recoveryChecks?: Map<string, { promise: Promise<void>; settledAt?: number; ttl: number }>;
  constructor(readonly runtime: ReturnType<typeof runtimeFromEnv>) {
    this.guardCandidate = runtime.launchGuardCandidate;
    this.firstBuyGuardCandidate = runtime.firstBuyGuardCandidate;
    this.feeEngineCandidate = runtime.config.feeEngine ?? null;
    const chainId = deploymentChain(runtime.config);
    this.client = createPublicClient({
      chain: { ...base, id: runtime.config.chainId, name: networkName(runtime.config) },
      transport: http(runtime.rpcUrl, {
        timeout: runtime.config.mode === "fork" ? 180_000 : 25_000,
        retryCount: 2,
        retryDelay: 500,
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
    this.runtime.lifi.budget = this.store;
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
    if (this.stocksCache && Date.now() - this.stocksCache.at < (this.stocksCache.ttl ?? 300_000))
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
                const result = await readLaunchAssetStatus(
                  this.client,
                  stock.address,
                  block,
                );
                return {
                  ...stock,
                  verified: result.identityVerified,
                  blockNumber: String(block),
                  onchainName: result.name,
                  totalSupply: result.totalSupply?.toString() ?? null,
                  multiplierWad: result.multiplierWad?.toString() ?? null,
                  availabilityWarning: result.warnings.map((warning) => warning.message).join(" ") || undefined,
                  oraclePaused: result.oraclePaused ?? undefined,
                  newMultiplierWad: result.newMultiplierWad?.toString() ?? null,
                  multiplierEffectiveAt: result.multiplierEffectiveAt,
                  paused: result.paused ?? undefined,
                };
              } catch (error) {
                return {
                  ...stock,
                  verified: false,
                  blockNumber: String(block),
                  totalSupply: null,
                  multiplierWad: null,
                  error: `Asset read or identity verification failed. Try refreshing later. ${redact(error, this.runtime.environment)}`,
                };
              }
            }),
          )),
        );
      // Known warnings are useful results, not reasons to hammer every asset.
      // Cache partial failures briefly without renewing the original block/time.
      const ttl = statuses.every(s => s.verified && !s.availabilityWarning) ? 300_000
        : statuses.every(s => s.verified) ? 30_000 : 5_000;
      this.stocksCache = { at: Date.now(), ttl, value: statuses };
      return statuses;
    })();
    try {
      return await this.stocksPromise;
    } finally {
      this.stocksPromise = undefined;
    }
  }
  private async guardIdentity(address: Address, requiredVersion?: "vesting") {
    const chainId = deploymentChain(this.runtime.config), key = `${chainId}:${address.toLowerCase()}:${requiredVersion ?? "any"}`;
    const cache = this.guardCache ??= new Map(), requests = this.guardRequests ??= new Map();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < (cached.value ? 300_000 : 3_000)) return cached.value;
    if (requests.has(key)) return requests.get(key)!;
    const request = verifyLaunchGuard(this.client, address, chainId, requiredVersion).then(value => {
      cache.set(key, {at: Date.now(), value}); return value;
    }, () => { cache.set(key, {at: Date.now(), value: null}); return null; });
    requests.set(key, request);
    try { return await request; } finally { requests.delete(key); }
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
    let assetFeedOracle: Address | null = null;
    let buybackVault: Address | null = null;
    for (const candidate of [
      { address: this.firstBuyGuardCandidate, requiredVersion: "vesting" as const },
      { address: this.guardCandidate, requiredVersion: undefined },
    ]) {
      if (!candidate.address || launchGuard) continue;
      try {
        await this.assertNetwork();
        const verified = await this.guardIdentity(candidate.address, candidate.requiredVersion);
        if (!verified) continue;
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
          // Exhausted finite source allowance only pauses source forwarding;
          // direct engine conversion and already funded vault work stay usable.
          feeEngine = verified.engine;
          buybackExecutor = verified.executor;
          assetFeedOracle = verified.assetOracle;
          buybackVault = verified.vault;
        }
      } catch { /* Candidate addresses are not exposed until the complete fixed graph is verified. */ }
    }
    let writesEnabled = this.runtime.config.writesEnabled, blockReason = this.runtime.config.blockReason, controlRevision = 0, signingPaused = false;
    if (this.runtime.config.mode !== "fork") {
      try {
        const control = await this.store.runtimeControl();
        controlRevision = control.revision;
        signingPaused = control.paused;
        if (control.paused) { writesEnabled = false; blockReason = control.reason || "New signing is temporarily paused."; }
      } catch { signingPaused = true; writesEnabled = false; blockReason = "Signing controls are temporarily unavailable."; }
    }
    return { ...this.runtime.config, writesEnabled, blockReason, controlRevision, signingPaused, securityProtocol: 1,
      curvePolicy: CURVE_POLICY, launchGuard, launchLockAvailable, feeEngine, buybackExecutor, automationReceiver, automationTreasury, wethForwarder, assetFeedOracle, buybackVault };
  }
  async openingValuation(quoteAddress: Address): Promise<LifiOpeningValuation> {
    const chainId = deploymentChain(this.runtime.config), key = `${chainId}:${quoteAddress.toLowerCase()}:${launchFeePolicy(this.runtime.config)}:${this.runtime.lifi?.integrator ?? ""}`;
    const cache = this.openingCache ??= new Map(), pending = this.openingRequests ??= new Map();
    const saved = cache.get(key), now = Date.now();
    if (saved && now - saved.at < 10_000 && now < saved.value.expiresAt - 10_000) return structuredClone(saved.value);
    if (pending.has(key)) return structuredClone(await pending.get(key)!);
    const request = readOpeningValuation(this.client, stockByAddress(quoteAddress, chainId), chainId,
      { ...this.runtime.lifi, rpcChainId: this.runtime.config.mode === "fork" && this.runtime.config.chainId === 31337 ? 31337 : chainId });
    pending.set(key, request);
    try {
      const value = await request;
      cache.set(key, { at: Date.now(), value });
      return structuredClone(value);
    } finally { pending.delete(key); }
  }
  async assertCreatorAccount(account: Address): Promise<void> {
    const code = await this.client.getCode({ address: account });
    // Delegated EOA transactions still have the EOA as the outer sender. Other
    // account-abstraction wallets submit through a relayer/EntryPoint, which
    // the current creation-receipt protocol cannot attribute to this creator.
    if (code && code !== "0x" && !/^0xef0100[\da-fA-F]{40}$/.test(code))
      throw new Error("This smart-account launch is not supported yet. Use a wallet that submits transactions directly before converting payment.");
  }
  async preflightFirstBuyPayment(rawQuoteAddress: unknown, options?: { fromToken?: Address; account?: Address }): Promise<void> {
    const quoteAddress = addressSchema.parse(rawQuoteAddress);
    if (!this.runtime.config.treasury) throw new Error("The platform treasury is not configured.");
    if (!launchAssetsFor(this.runtime.config).some((asset) => sameAddress(asset.address, quoteAddress)))
      throw new Error("This asset is unavailable for a new launch because it is not in the verified LI.FI opening-price pairing list.");
    await this.assertNetwork();
    if (options?.account) await this.assertCreatorAccount(options.account);
    const config = await this.config();
    this.assertLaunchPolicyCurrent(launchFeePolicy(config));
    if (launchFeePolicy(config) === ENGINE_FEE_POLICY && !config.feeEngine)
      throw new Error("The configured fee engine could not be verified. Try again after deployment verification.");
    if (!config.launchGuard)
      throw new Error("Atomic first buys are unavailable until the launch guard is configured and verified.");
    await readLaunchAssetStatus(this.client, quoteAddress);
    // Conversion precedes launch, so reject already-known blockers before the
    // separate payment. This does not prepare or persist a launch snapshot.
    const stock = stockByAddress(quoteAddress, deploymentChain(this.runtime.config));
    const nativeWrap = options?.fromToken !== undefined && sameAddress(options.fromToken, zeroAddress) && stock.symbol === "WETH";
    if (!nativeWrap) await this.openingValuation(quoteAddress);
  }
  async prepare(raw: unknown, rawCreator: unknown, expectedCurvePolicy?: unknown, firstBuy?: unknown, rawOptions?: LaunchPrepareOptions): Promise<LaunchPlan> {
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
    const options = prepareOptionsSchema.parse(rawOptions ?? {});
    const previous = options.previousPlanId ? await this.store.getPlan(options.previousPlanId) : null;
    if (options.previousPlanId && (!previous || previous.recovered || !sameAddress(previous.creator, creator) || !options.intentId || previous.intentId !== options.intentId ||
      !previous.prepared || !sameAddress(previous.draft.quoteAddress, draft.quoteAddress) ||
      previous.draft.tradingFeeBps !== draft.tradingFeeBps ||
      (previous.firstBuy?.lockDays ?? 0) !== (buy?.lockDays ?? 0) ||
      (previous.firstBuy?.slippageBps ?? buy?.slippageBps) !== buy?.slippageBps ||
      (previous.firstBuy?.amount ?? "0") !== (buy?.amount ?? "0")))
      throw new Error("The refreshed launch must match the same creator, intent and reviewed purchase.");
    if (options.reconfirmPrice && (!previous?.requiresReconfirmation || !previous.firstBuy || !options.reconfirmedMinimumOut ||
      BigInt(options.reconfirmedMinimumOut) !== minimumOutput(BigInt(previous.firstBuy.expectedAmountOut), previous.firstBuy.slippageBps)))
      throw new Error("Review the changed minimum before confirming this refreshed price.");
    const amountIn = buy && !/^0(?:\.0+)?$/.test(buy.amount) ? parseAmount(buy.amount, stock.decimals) : 0n;
    if (buy?.lockDays && amountIn === 0n) throw new Error("A locked first buy requires a positive amount.");
    await this.assertNetwork();
    await this.assertCreatorAccount(creator);
    const launchConfig = await this.config();
    const feePolicy = launchFeePolicy(launchConfig);
    this.assertLaunchPolicyCurrent(feePolicy);
    if (feePolicy === ENGINE_FEE_POLICY && !launchConfig.feeEngine)
      throw new Error("The configured fee engine could not be verified. Try again after deployment verification.");
    let guard: Address | null = null;
    if (amountIn > 0n) {
      guard = launchConfig.launchGuard ?? null;
      if (!guard) throw new Error("Atomic first buys are unavailable until the launch guard is configured and verified.");
      if (buy?.lockDays && !launchConfig.launchLockAvailable)
        throw new Error("First buy locking is unavailable until the vesting launch guard is deployed and verified on this network.");
    }
    const assetStatus = await readLaunchAssetStatus(this.client, draft.quoteAddress);
    const chainId = deploymentChain(this.runtime.config);
    const openingValuation = await this.openingValuation(draft.quoteAddress);
    const protocolOwner = await this.sdk.getAirlockOwner();
    const params = buildLaunch(this.sdk, draft, creator, treasury, protocolOwner, openingValuation,
      previous?.prepared?.createParams.salt, chainId, launchConfig.feeEngine ?? undefined);
    if (amountIn > 0n) {
      params.modules = { ...params.modules, bundler: chainLaunchDependencies(chainId).bundler };
      const duration = BigInt(buy?.lockDays ?? 0) * 86400n;
      params.devBuy = { exactAmountIn: amountIn, recipient: creator,
        vesting: { permissionlessClaim: false, vestingDuration: duration, cliffDuration: duration } };
    }
    const prepared = await this.sdk.factory.prepareCreateMulticurve(params, { account: creator })
      .catch((error: unknown) => { throw simulationError(error); });
    const { prediction } = prepared;
    const finalizedAt = Date.now(), signingExpiresAt = finalizedAt + LAUNCH_SIGNING_TTL;
    let firstBuyPlan: LaunchPlan["firstBuy"], approval: LaunchPlan["approval"];
    let gas = prepared.gasEstimate.status === "estimated" ? prepared.gasEstimate.gas.toString() : null;
    if (amountIn > 0n && guard && buy && prepared.devBuy) {
      const expectedAmountOut = prepared.devBuy.simulatedAmountOut;
      const previousMinimum = options.reconfirmPrice ? BigInt(options.reconfirmedMinimumOut!)
        : previous?.firstBuy ? BigInt(previous.firstBuy.acceptedMinAmountOut ?? previous.firstBuy.minAmountOut)
        : BigInt(options.acceptedMinAmountOut ?? minimumOutput(expectedAmountOut, buy.slippageBps));
      const requestedMinimum = options.reconfirmPrice ? previousMinimum : BigInt(options.acceptedMinAmountOut ?? previousMinimum);
      const acceptedMinAmountOut = requestedMinimum > previousMinimum ? requestedMinimum : previousMinimum;
      const freshMinimum = minimumOutput(expectedAmountOut, buy.slippageBps);
      const minAmountOut = freshMinimum > acceptedMinAmountOut ? freshMinimum : acceptedMinAmountOut;
      const deadline = Math.floor(signingExpiresAt / 1000);
      firstBuyPlan = { amount: buy.amount, amountIn: String(amountIn), expectedAmountOut: String(expectedAmountOut),
        minAmountOut: String(minAmountOut), acceptedMinAmountOut: String(acceptedMinAmountOut), slippageBps: buy.slippageBps, deadline, recipient: creator,
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
      draft: { ...draft, openingCap: openingCapInQuote(openingValuation) }, preparedAt: finalizedAt, gas,
      validityVersion: 2, finalizedAt, signingExpiresAt, serverTime: Date.now(), intentId: options.intentId ?? crypto.randomUUID(),
      previousPlanId: previous?.id,
      requiresReconfirmation: !!firstBuyPlan && BigInt(firstBuyPlan.expectedAmountOut) < BigInt(firstBuyPlan.minAmountOut),
      warnings: [...assetStatus.warnings, ...(openingValuation.warnings ?? [])],
      feePolicy, feeTreasury: treasury, feeEngine: launchConfig.feeEngine ?? undefined, openingValuation, curvePolicy: CURVE_POLICY,
      prepared: serializePrepared(prepared), transaction, firstBuy: firstBuyPlan, approval,
    };
    assertOpeningValuation(openingValuation, stock.address, chainId, finalizedAt);
    assertPlanIntegrity(plan, this.contracts);
    const attestationKey = this.runtime.secrets?.planAttestationKey;
    if (attestationKey) plan.attestation = planAttestation(attestationKey, chainId, plan.id);
    await this.store.savePlan(plan);
    return plan;
  }
  async validateLaunch(creator: Address, data: Hex, signing = false) {
    const plan = await this.store.findPlan(creator, data);
    if (plan?.recovered) throw new Error("This preview was restored from a backup and cannot be signed. Run a new preview.");
    if (!plan || plan.curvePolicy !== CURVE_POLICY)
      throw new Error("The issuance curve policy has changed. Run a new preview.");
    if (plan.feePolicy !== launchFeePolicy(this.runtime.config))
      throw new Error("The issuance fee policy has changed. Run a new simulation.");
    if (!this.assets.some((asset) => sameAddress(asset.address, plan.draft.quoteAddress)))
      throw new Error("The paired asset is no longer supported on the active network. Run a new simulation.");
    if (!plan.feeTreasury || !this.runtime.config.treasury || !sameAddress(plan.feeTreasury, this.runtime.config.treasury))
      throw new Error("The issuance preview expired or the treasury changed. Simulate again.");
    assertLaunchPlanValidity(plan, deploymentChain(this.runtime.config));
    if (plan.requiresReconfirmation) throw new Error("The refreshed price is below your accepted minimum. Review the changed price before signing.");
    assertPlanIntegrity(plan, this.contracts);
    const config = await this.config();
    assertSigningEnabled(config);
    if (plan.firstBuy || plan.feePolicy === ENGINE_FEE_POLICY) {
      if (plan.feePolicy === ENGINE_FEE_POLICY && (!config.feeEngine || !plan.feeEngine || !sameAddress(config.feeEngine, plan.feeEngine)))
        throw new Error("The fee engine configuration changed or could not be verified. Run a new preview.");
      if (plan.firstBuy && (!config.launchGuard || !sameAddress(config.launchGuard, plan.firstBuy.guard)))
        throw new Error("The launch guard configuration changed or could not be verified. Run a new preview.");
      if (plan.firstBuy?.lockDays && !config.launchLockAvailable)
        throw new Error("The first buy lock guard could not be verified. Run a new preview.");
    }
    // Simulation is still an unsigned preview. Protect only when the client is
    // entering a real wallet signature; unknown submissions must not age out.
    if (signing) await this.store.protectPlan(plan.id);
    return { valid: true, feePolicy: plan.feePolicy, curvePolicy: plan.curvePolicy, planId: plan.id,
      validityVersion: plan.validityVersion, signingExpiresAt: plan.signingExpiresAt, intentId: plan.intentId, serverTime: Date.now() };
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
      if (BigInt(amountOut) < BigInt(buy.minAmountOut))
        throw new Error("The first buy output is below your accepted minimum. Review the changed price before signing.");
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
  async register(hash: Hex, recoveryPlan?: LaunchPlan): Promise<TokenRecord> {
    hash = hash.toLowerCase() as Hex;
    // Concurrent retries of one transaction share a verification. A different
    // backup runs separately, so one caller's invalid JSON cannot fail another's.
    const key = `${hash}:${recoveryPlan ? keccak256(stringToBytes(JSON.stringify(recoveryPlan))) : "saved"}`;
    const requests = this.registerRequests ??= new Map();
    const pending = requests.get(key);
    if (pending) return pending;
    const request = this.registerOnce(hash, recoveryPlan);
    requests.set(key, request);
    try { return await request; } finally { requests.delete(key); }
  }
  /** The committed engine deployment manifest (replaceable in tests). */
  private launchManifest() { return ENGINE_MANIFEST; }
  private launchCutover() { return engineLaunchCutover(this.runtime.config, this.launchManifest()); }
  /** From the recorded cutover, Robinhood launches route fees through the
   * engine; recovery trusts treasury-only routing only until then plus the
   * signing window, so issuing one afterwards would strand it. */
  private assertLaunchPolicyCurrent(feePolicy: string) {
    const cutover = this.launchCutover();
    if (cutover && feePolicy !== ENGINE_FEE_POLICY && Date.now() >= cutover.timestamp * 1000)
      throw new Error("New Robinhood launches now route fees through the buyback engine, which is not available yet. Try again after it is configured.");
  }
  private async assertCanonicalCutover(cutover: EngineLaunchCutover) {
    const key = `${cutover.blockNumber}:${cutover.blockHash.toLowerCase()}:${cutover.timestamp}`;
    if (this.cutoverCheck?.key === key && Date.now() < this.cutoverCheck.until) return;
    const block = await this.client.getBlock({ blockNumber: BigInt(cutover.blockNumber) });
    if (!block.hash || block.hash.toLowerCase() !== cutover.blockHash.toLowerCase() || block.timestamp !== BigInt(cutover.timestamp))
      throw new Error("The recorded engine launch cutover is not a canonical block, so treasury-only launches cannot be recovered until it is corrected.");
    // Remembered for good only once finalized; until then it is checked again
    // shortly, so a reorganized cutover block cannot keep being trusted.
    this.cutoverCheck = { key, until: await this.finalizedThrough(BigInt(cutover.blockNumber)) ? Infinity : Date.now() + RECOVERY_TRANSIENT_RETRY_MS };
  }
  /** Whether the chain's finalized head has reached this block. An RPC
   * without the finalized tag never reports a block as final. */
  private async finalizedThrough(blockNumber: bigint) {
    const finalized = (await this.client.getBlock({ blockTag: "finalized" }).catch(() => null))?.number;
    return finalized !== null && finalized !== undefined && finalized >= blockNumber;
  }
  /** Bounds the RPC work recovered backups can trigger across all callers. A
   * capacity refusal is a retryable 429, never a challenge to a real recovery. */
  private async withRecoveryVerification<T>(work: () => Promise<T>): Promise<T> {
    const load = this.recoveryLoad ??= { active: 0, started: [] }, now = Date.now();
    load.started = load.started.filter((at) => at > now - 60_000);
    if (load.active >= RECOVERY_VERIFICATION_CONCURRENCY) throw new BudgetUnavailable(2);
    if (load.started.length >= RECOVERY_VERIFICATIONS_PER_MINUTE)
      throw new BudgetUnavailable(Math.max(1, Math.ceil((load.started[0] + 60_000 - now) / 1000)));
    load.active++; load.started.push(now);
    try { return await work(); } finally { load.active--; }
  }
  /** Chain evidence for a recovered preview that already re-encodes the
   * transaction exactly. Every input here (opening valuation, guard, token) is
   * fixed by that transaction's calldata, so any backup reaching this point
   * shares one in-flight check and its cached result per transaction and
   * receipt block. Altered backups fail re-encoding first and never reach it,
   * so they can neither spend the shared budget nor delay the correct backup. */
  private recoveryEvidence(hash: Hex, plan: LaunchPlan, receipt: { blockNumber: bigint; blockHash: Hex }): Promise<void> {
    const checks = this.recoveryChecks ??= new Map(), now = Date.now();
    // Evidence is judged at the receipt block. A transaction re-mined in
    // another block after a reorganization is a different key, checked afresh.
    const key = `${hash}:${receipt.blockHash.toLowerCase()}`;
    const known = checks.get(key);
    if (known && (known.settledAt === undefined || now - known.settledAt < known.ttl)) return known.promise;
    if (checks.size >= 10_000)
      for (const [key, entry] of checks) if (entry.settledAt !== undefined && now - entry.settledAt >= entry.ttl) checks.delete(key);
    const entry: { promise: Promise<void>; settledAt?: number; ttl: number } = { promise: Promise.resolve(), ttl: 0 };
    const chainId = deploymentChain(this.runtime.config);
    entry.promise = this.withRecoveryVerification(async () => {
      const reference = await assertRecoveredOpeningValuation(this.client, plan.openingValuation!, receipt.blockNumber, chainId);
      // Advisory, like the review-time warning; provenance is decided by attestation.
      if (reference && reference.divergenceBps > LIFI_OPENING_MAX_DIVERGENCE_BPS)
        console.warn(JSON.stringify({ event: "recovery_reference_divergence", transactionHash: hash, token: plan.tokenAddress, divergenceBps: reference.divergenceBps }));
      if (plan.firstBuy) await verifyLaunchGuard(this.client, plan.firstBuy.guard, chainId, plan.firstBuy.lockDays ? "vesting" : undefined);
      // The reads above are by block number; keep their verdict only for the
      // receipt block they actually saw.
      const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
      if (!block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
        throw new Error("The receipt block was reorganized. Wait for confirmation again.");
    }).then(() => { entry.settledAt = Date.now(); entry.ttl = RECOVERY_RESULT_TTL_MS; }, async (error: unknown) => {
      // A definitive evidence failure is kept long only once its receipt block
      // is finalized, when no reorganization or lagging RPC node can change
      // it; before that, and for an RPC failure, only briefly. A capacity
      // refusal is not kept at all, so the next request competes again.
      const final = error instanceof RecoveryEvidenceError && await this.finalizedThrough(receipt.blockNumber);
      entry.settledAt = Date.now();
      entry.ttl = final ? RECOVERY_RESULT_TTL_MS : error instanceof BudgetUnavailable ? 0 : RECOVERY_TRANSIENT_RETRY_MS;
      throw error;
    });
    checks.set(key, entry);
    return entry.promise;
  }
  private async registerOnce(hash: Hex, recoveryPlan?: LaunchPlan): Promise<TokenRecord> {
    // Receipt verification does not sign or broadcast. Keep it available when
    // signing is disabled so transactions already sent can finish registering.
    await this.assertNetwork();
    const receipt = await this.client.getTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("This creation transaction did not succeed.");
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    if (head < receipt.blockNumber + 1n)
      throw new Error("Wait for at least two block confirmations before registering.");
    const tx = await this.client.getTransaction({ hash });
    // Only a preview prepare() saved is this service's own. One stored by an
    // earlier recovery is still a caller backup: a retry verifies it again and
    // it proves its opening valuation only by attestation.
    const stored = await this.store.findPlan(receipt.from, tx.input);
    const savedPlan = stored && !stored.recovered ? stored : null;
    const plan = savedPlan ?? recoveryPlan ?? stored;
    if (!plan)
      throw new Error("No matching issuance preview was found. Supply the frozen local backup with the original transaction hash.");
    // Cheapest rejections first, for saved and recovered previews alike: the
    // outer transaction must be exactly this preview's before any RPC-backed
    // or SDK re-encoding work runs.
    assertLaunchTransaction(plan, tx, this.contracts);
    if (!receipt.to || !sameAddress(receipt.to, plan.transaction?.to ?? this.contracts.airlock) || !sameAddress(receipt.from, plan.creator))
      throw new Error("The creation receipt does not match the preview's outer transaction.");
    if (!savedPlan) {
      // A backup's fee routing must also be platform-approved before that work.
      if (keccak256(plan.data) !== plan.id) throw new Error("The creation receipt does not match the preview's outer transaction.");
      // Treasury-only routing after a recorded engine cutover is judged by the
      // receipt's canonical block time; nothing else needs that block yet.
      const cutover = plan.feePolicy === FEE_POLICY ? this.launchCutover() : undefined;
      let timestamp = 0n;
      if (cutover) {
        await this.assertCanonicalCutover(cutover);
        const receiptBlock = await this.client.getBlock({ blockNumber: receipt.blockNumber });
        if (receiptBlock.hash !== receipt.blockHash) throw new Error("The receipt block was reorganized. Wait for confirmation again.");
        timestamp = receiptBlock.timestamp;
      }
      assertTrustedLaunchPolicy(plan, this.runtime.config, { blockNumber: receipt.blockNumber, timestamp },
        trustedLaunchPolicies(this.runtime.config, this.launchManifest()));
      // CPU only: an altered backup fails here, before any shared RPC budget.
      assertRecoveryPlan(plan, this.contracts, this.sdk);
      await this.recoveryEvidence(hash, plan, receipt);
    }
    if (plan.openingValuation)
      assertHistoricalOpeningValuation(plan.openingValuation, plan.draft.quoteAddress, deploymentChain(this.runtime.config));
    if (plan.prepared) {
      const verified = await verifyPreparedCreateExecution({ prepared: restorePrepared(plan.prepared), receipt, publicClient: this.client });
      if (plan.firstBuy) verifyGuardedReceipt(plan, receipt, verified.devBuy?.amountOut);
    } else if (plan.firstBuy) throw new Error("The guarded creation snapshot is missing.");
    if (savedPlan) await this.store.trackLaunch(hash, plan.id);
    const events = receipt.logs
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
      .filter((e) => sameAddress(e.asset, plan.tokenAddress));
    const event = events[0];
    if (
      events.length !== 1 || !event ||
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
    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash)
      throw new Error("The receipt block was reorganized. Wait for confirmation again.");
    const transfers = verifyCreationAccounting(plan, receipt, this.contracts, tradingFeeBps);
    const firstBuyLock = verifiedFirstBuyLock(plan, receipt, block.timestamp);
    if (firstBuyLock) {
      const custody = transfers.reduce((sum, transfer) => sum +
        (sameAddress(transfer.to, firstBuyLock.bundler) ? transfer.value : 0n) -
        (sameAddress(transfer.from, firstBuyLock.bundler) ? transfer.value : 0n), 0n);
      if (custody !== BigInt(firstBuyLock.totalAmount))
        throw new Error("The first buy lock custody does not match its creation receipt.");
    }
    // prepare() saved a normalized draft. A recovered draft is caller JSON that
    // only re-encoded through launchSchema, so persist that normalized form.
    const { openingCap, ...fields } = plan.draft;
    const draft = savedPlan ? plan.draft : { ...launchSchema.parse(fields), ...(openingCap !== undefined ? { openingCap } : {}) };
    // A saved preview was prepared by this service. A backup proves its
    // opening valuation only with a platform attestation over its id.
    const keys = [this.runtime.secrets?.planAttestationKey, ...(this.runtime.secrets?.planAttestationPreviousKeys ?? [])]
      .filter((key): key is string => !!key);
    // Both previews encode this transaction, so they share its id; an
    // attestation kept from an earlier recovery attempt still counts.
    const attestation = savedPlan ? undefined : [plan.attestation, stored?.attestation]
      .find((value) => verifyPlanAttestation(keys, deploymentChain(this.runtime.config), plan.id, value));
    const attested = !!savedPlan || attestation !== undefined;
    const token: TokenRecord = {
      ...draft,
      ...(attested ? {} : { openingValuationUnverified: true as const }),
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
    if (!savedPlan) {
      const restored = Object.fromEntries(LAUNCH_PLAN_FIELDS.filter((field) => plan[field] !== undefined)
        .map((field) => [field, field === "draft" ? draft : plan[field]])) as LaunchPlan;
      // Keep the attestation that verified, else the backup's own: a retained
      // previous key added later can still verify it.
      const kept = attestation ?? plan.attestation;
      await this.store.savePlan({ ...restored, recovered: true, ...(kept ? { attestation: kept } : {}) });
      await this.store.protectPlan(plan.id); await this.store.trackLaunch(hash, plan.id);
    }
    // A token is written once, and its provenance may only improve: a launch
    // first registered from an unattested backup becomes verified once an
    // attested backup or a retained key proves its opening valuation, in
    // whichever order concurrent registrations land.
    await this.store.saveToken(token);
    await this.store.upgradeTokenProvenance(token);
    this.invalidateTokens();
    await this.store.launchStatus(hash, "confirmed", receipt.blockHash);
    return await this.store.tokenByTxHash(hash) ?? token;
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
      const finalized = await this.client.getBlock({ blockTag: "finalized" }).catch(() => null);
      const cursor = rows.findIndex((row) => row.hash === this.reconcileCursor);
      const ordered = [...rows.slice(cursor + 1), ...rows.slice(0, cursor + 1)];
      for (const row of ordered) {
        // Finish each row before yielding the remaining queue to the
        // next maintenance event. RPC timeouts retain the same receipt status.
        if (Date.now() >= deadline) break;
        try {
          const token = await this.store.tokenByTxHash(row.hash);
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
              this.invalidateTokens();
              await this.store.launchStatus(row.hash, "pending");
            } else if (row.status === "confirmed") {
              // Only a node-reported finalized block leaves the hot queue.
              // Older receipts are rechecked less often if finality is unavailable.
              if (finalized?.number !== null && finalized?.number !== undefined && BigInt(token.blockNumber) <= finalized.number)
                await this.store.finalizeLaunch(row.hash);
              else if (!finalized && Date.now() - token.createdAt >= 86_400_000)
                await this.store.deferLaunch(row.hash, Date.now() + 3_600_000);
              else await this.store.deferLaunch(row.hash, Date.now() + 60_000);
              continue;
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
            this.invalidateTokens();
            await this.store.launchStatus(row.hash, "failed");
          } else await this.register(row.hash);
        } catch {
          /* Upstream absence or timeout is not evidence of failure. Retry after restart or next tick. */
          await this.store.deferLaunch(row.hash, Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(row.attempts ?? 0, 6)));
        } finally {
          this.reconcileCursor = row.hash;
        }
      }
    } finally {
      this.reconciling = false;
    }
  }
  async state(address: Address, record?: TokenRecord) {
    await this.assertNetwork();
    const token = record ?? await this.token(address);
    const state = await (await this.sdk.getMulticurvePool(address)).getState();
    if (
      state.status !== 2 ||
      !sameAddress(state.numeraire, token.quoteAddress) ||
      computePoolId(state.poolKey) !== token.poolId
    )
      throw new PoolIdentityError("The pool identity or locked state is invalid");
    return { token, state };
  }
  /** One pool state read per token at a time. A token page read abandoned at
   * its deadline keeps running, so later viewers and retries share it rather
   * than stacking new RPC work during a slowdown. */
  private sharedState(token: TokenRecord) {
    const key = token.address.toLowerCase(), reads = this.stateReads ??= new Map();
    const pending = reads.get(key);
    if (pending) return pending;
    const read: ReturnType<LaunchpadService["state"]> = this.state(token.address, token)
      .finally(() => { if (reads.get(key) === read) reads.delete(key); });
    reads.set(key, read);
    return read;
  }
  /** Catalog metadata comes from storage; pool state needs the RPC. A failed
   * or slow state read leaves the record readable but reports no tradable
   * state, well inside the client's request deadline (RPC retries alone can
   * exceed it). A pool that contradicts the record is reported as invalid,
   * not as a transient outage. */
  async tokenDetail(address: Address, stateDeadlineMs = TOKEN_STATE_DEADLINE_MS): Promise<{ token: TokenRecord;
    state: Awaited<ReturnType<LaunchpadService["state"]>>["state"] | null; stateError?: string; stateInvalid?: true } | null> {
    const token = await this.store.token(address);
    if (!token || !listedTokens([token], this.runtime.config.mode, deploymentChain(this.runtime.config)).length) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { state } = await Promise.race([this.sharedState(token), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The on-chain pool state read timed out.")), stateDeadlineMs);
      })]);
      return { token, state };
    } catch (error) {
      return { token, state: null, stateError: redact(error, this.runtime.environment), ...(error instanceof PoolIdentityError ? { stateInvalid: true as const } : {}) };
    } finally { clearTimeout(timer); }
  }
  async tokens() {
    if (this.tokensCache && Date.now() - this.tokensCache.at < 10_000) return structuredClone(this.tokensCache.value);
    if (this.tokensPromise) return structuredClone(await this.tokensPromise);
    const revision = this.tokensRevision ?? 0;
    const request = Promise.resolve(this.store.tokens()).then(rows => {
      const value = listedTokens(rows, this.runtime.config.mode, deploymentChain(this.runtime.config));
      if (revision === (this.tokensRevision ?? 0)) this.tokensCache = {at: Date.now(), value}; return value;
    });
    this.tokensPromise = request;
    try { return structuredClone(await request); } finally { if (this.tokensPromise === request) this.tokensPromise = undefined; }
  }
  private invalidateTokens() {
    this.tokensRevision = (this.tokensRevision ?? 0) + 1;
    this.tokensCache = undefined; this.tokensPromise = undefined;
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
    const chainId = deploymentChain(this.runtime.config), dependencies = chainLaunchDependencies(chainId);
    // Catalog/database availability never gates a user's on-chain custody.
    const tokenLookup = Promise.resolve().then(() => this.store.token(address)).catch(() => null);
    const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
    const [code, position, claimable] = await Promise.all([
      this.client.getCode({ address: dependencies.bundler, blockNumber }),
      this.client.readContract({ address: dependencies.bundler, abi: bundlerAbi, functionName: "vestingOf", args: [address], blockNumber }),
      this.client.readContract({ address: dependencies.bundler, abi: bundlerAbi, functionName: "claimable", args: [address], blockNumber }),
    ]);
    if (!code || keccak256(code) !== dependencies.bundlerCodeHash)
      throw new Error("The first buy Bundler identity does not match this network.");
    const state = firstBuyLockStatusFromPosition(address, chainId, dependencies.bundler, position, claimable);
    if (!state) return null;
    // A slow or absent catalog cannot hold up an on-chain claim. Its metadata is optional.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = await Promise.race([tokenLookup, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 500); })]);
    clearTimeout(timer);
    const verifiedState = firstBuyLockStatusFromPosition(address, chainId, dependencies.bundler, position, claimable, token?.firstBuyLock)!;
    const metadata = await Promise.race([Promise.allSettled([
      this.client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber }),
      this.client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber }),
    ]), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1_000); })]);
    clearTimeout(timer);
    const symbol = metadata?.[0], decimals = metadata?.[1];
    return { ...verifiedState,
      symbol: symbol?.status === "fulfilled" && typeof symbol.value === "string" && symbol.value.length <= 64 ? symbol.value : token?.symbol,
      decimals: decimals?.status === "fulfilled" && Number.isInteger(decimals.value) && decimals.value >= 0 && decimals.value <= 36 ? decimals.value : token ? 18 : undefined };
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
const prepareOptionsSchema = z.object({ intentId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/).optional(),
  previousPlanId: z.string().regex(/^0x[\da-fA-F]{64}$/).optional(),
  acceptedMinAmountOut: z.string().regex(/^[1-9]\d{0,38}$/).refine((value) => BigInt(value) < 2n ** 128n).optional(),
  reconfirmPrice: z.boolean().optional(),
  reconfirmedMinimumOut: z.string().regex(/^[1-9]\d{0,38}$/).refine((value) => BigInt(value) < 2n ** 128n).optional(),
}).strict();
// Client API requests give up after 35 seconds; token metadata must arrive first.
const TOKEN_STATE_DEADLINE_MS = 8_000;
// Recovery verification reads several historical blocks and re-encodes the
// SDK parameters. Real recoveries are rare; this leaves ample headroom.
const RECOVERY_VERIFICATION_CONCURRENCY = 4;
const RECOVERY_VERIFICATIONS_PER_MINUTE = 60;
// A transaction's settled chain evidence at one receipt block is reused for
// this long; a failure that could still change only briefly, so a later retry
// can succeed.
const RECOVERY_RESULT_TTL_MS = 600_000;
const RECOVERY_TRANSIENT_RETRY_MS = 15_000;
// A stored recovered preview keeps only known LaunchPlan fields.
const LAUNCH_PLAN_FIELDS = ["id", "creator", "data", "tokenAddress", "poolId", "draft", "preparedAt", "validityVersion", "finalizedAt",
  "signingExpiresAt", "serverTime", "intentId", "previousPlanId", "requiresReconfirmation", "warnings", "gas", "feePolicy", "feeTreasury",
  "feeEngine", "openingValuation", "curvePolicy", "prepared", "transaction", "firstBuy", "approval", "attestation"] as const satisfies readonly (keyof LaunchPlan)[];

function assertLaunchTransaction(plan: LaunchPlan, tx: { from: Address; to: Address | null; input: Hex; value: bigint }, contracts: ContractRegistry) {
  const target = plan.transaction?.to ?? contracts.airlock;
  if (!tx.to || !sameAddress(tx.to, target) || !sameAddress(tx.from, plan.creator) ||
      tx.input.toLowerCase() !== plan.data.toLowerCase() || tx.value !== BigInt(plan.transaction?.value ?? "0"))
    throw new Error("The outer transaction does not match the issuance preview.");
  assertLaunchTradingFee(plan, tx.input, contracts);
}
