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
  parseUnits,
  stringToBytes,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { base, robinhood } from "viem/chains";
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
import { ENGINE_FEE_POLICY, FEE_POLICY, isEngineFeePolicy, launchFeePolicy } from "../src/lib/fee-policy";
import { tradingFeeBpsFor } from "../src/lib/trading-fee";
import { assertOpeningValuation, assertHistoricalOpeningValuation, openingCapInQuote, LIFI_OPENING_MAX_DIVERGENCE_BPS, type LifiOpeningValuation, type OpeningValuation } from "../src/lib/opening-valuation";
import { assertRecoveredOpeningValuation, readOpeningValuation, RecoveryEvidenceError } from "./opening-price";
import {
  addressSchema,
  launchSchema,
  parseAmount,
  minimumOutput,
  errorMessage,
  parseNftQuery,
  simulationError,
  assertSigningEnabled,
} from "../src/lib/validation";
import { SupabaseStore, type StoreBackend } from "./supabase-store";
import { z } from "zod";
import { Store, TokenUniqueConflict, type LaunchPlan } from "./store";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { launchGuardAbi } from "../src/lib/launch-guard";
import { assertLaunchPlanValidity, LAUNCH_SIGNING_TTL, restorePrepared, serializePrepared, type FirstBuyLockStatus, type LaunchPrepareOptions } from "../src/lib/launch-plan";
import { chainLaunchDependencies, LaunchGuardMismatch, verifyLaunchGuard, verifyLaunchGuardIdentity } from "./launch-guard";
import { assertLaunchTradingFee, assertPlanIntegrity, assertRecoveryPlan, verifiedFirstBuyLock, verifyCreationAccounting, verifyGuardedReceipt } from "./launch-verification";
import { verifyFeeEngine } from "./buyback-engine";
import { alchemyRpcTransport } from "./alchemy-rpc";
import { BASE_COLLECTOR_MANIFEST, baseCollectorGraphFingerprint, verifyBaseCollector } from "./base-collector";
import { hasBaseLaunchActivationRecord } from "./base-activation-record";
import { assertTrustedLaunchPolicy, engineLaunchCutover, ENGINE_MANIFEST, trustedLaunchPolicies, type EngineLaunchCutover } from "./launch-policy-registry";
import { planAttestation, verifyPlanAttestation } from "./plan-attestation";
import { BudgetUnavailable } from "./runtime-policy";
import { NftLaunchError, assertNftDraftRules, inspectVaultFactory, launchFeeQuoteMac, nftRegistrationStatus, readMuseAgentId, readMuseName, readNftControl, settleLaunchFee, verifyLaunchFeePayment, type NftRegistrationStatus, type RegistrationFee } from "./nft-launch";
import { isMuse, nftKey, treasuryFor, vaultFor, type NftRef, type NftStatus } from "../src/lib/nft-mode";
import { LAUNCH_FEE_QUOTE_TTL, LAUNCH_FEE_STABLE, LAUNCH_FEE_USD, type LaunchFee } from "../src/lib/launch-fee";
import type { EngineClaimPreview } from "../src/lib/buyback-engine";

import { runtimeFromEnv, mainnetRpcUrl, redact } from "./config";
export { runtimeFromEnv } from "./config";
/** The on-chain pool contradicts the stored listing; never a transient outage. */
export class PoolIdentityError extends Error {}
/** `/launch/track` queued the creation but could not store its NFT claim as submitted: the route answers 503 with a short Retry-After, which
 * the client's API layer retries (src/lib/api.ts). */
export class LaunchClaimUnavailable extends Error {
  constructor() { super("The transaction is queued, but its NFT reservation could not be saved yet. Try again."); this.name = "LaunchClaimUnavailable"; }
}
export class LaunchpadService {
  readonly client;
  readonly sdk;
  get contracts() { return contractsFor(this.runtime.config); }
  get assets() { return assetsFor(this.runtime.config); }
  readonly store: StoreBackend;
  private readonly guardCandidate: Address | null;
  private readonly firstBuyGuardCandidate: Address | null;
  private readonly feeEngineCandidate: Address | null;
  private baseDestinationClient?: ReturnType<typeof createPublicClient>;
  private stocksCache?: { at: number; ttl?: number; value: StockStatus[] };
  private stocksPromise?: Promise<StockStatus[]>;
  private guardCache?: Map<string, {at: number; ttl: number; failures: number; value: Awaited<ReturnType<typeof verifyLaunchGuard>> | null}>;
  private guardRequests?: Map<string, Promise<Awaited<ReturnType<typeof verifyLaunchGuard>> | null>>;
  private tokensCache?: {at: number; value: TokenRecord[]};
  private tokensPromise?: Promise<TokenRecord[]>;
  private tokensRevision = 0;
  private openingCache?: Map<string, { at: number; value: LifiOpeningValuation }>;
  private museProfiles?: Map<string, { name?: string; agentId?: string }>;
  private openingRequests?: Map<string, Promise<LifiOpeningValuation>>;
  private registerRequests?: Map<string, Promise<TokenRecord>>;
  private stateReads?: Map<string, ReturnType<LaunchpadService["state"]>>;
  private recoveryLoad?: { active: number; started: number[] };
  private cutoverCheck?: { key: string; until: number };
  private recoveryChecks?: Map<string, RememberedCheck>;
  private anchorChecks?: Map<string, RememberedCheck>;
  private guardMismatches?: Map<string, number>;
  private displayConfigCache?: { at: number; value: RuntimeConfig };
  private displayConfigPromise?: Promise<RuntimeConfig>;
  private nftFactoryCheck?: { at: number; ttl: number; value: Address | null };
  private nftFactoryRequest?: Promise<Address | null>;
  private nftGuardsCheck?: { at: number; ttl: number; value: boolean };
  private nftGuardsRequest?: Promise<boolean>;
  private stockFailures = 0;
  constructor(readonly runtime: ReturnType<typeof runtimeFromEnv>) {
    this.guardCandidate = runtime.launchGuardCandidate;
    this.firstBuyGuardCandidate = runtime.firstBuyGuardCandidate;
    this.feeEngineCandidate = runtime.config.feeEngine ?? null;
    const chainId = deploymentChain(runtime.config);
    this.client = createPublicClient({
      chain: { ...base, id: runtime.config.chainId, name: networkName(runtime.config) },
      transport: runtime.config.mode !== "fork" && runtime.environment?.NODE_ENV === "production" ? alchemyRpcTransport(chainId,runtime.environment,{timeout:25_000}) : http(runtime.rpcUrl, {
        // Multicall combines eth_call only. Batch the remaining read-only RPC
        // methods too, so a cold verification fits the Worker fetch budget.
        batch: { batchSize: 20, wait: 0 },
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
    if (this.runtime.config.mode !== "fork" && this.runtime.environment?.NODE_ENV === "production")
      return this.client.request({ method, params } as any);
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
      this.stockFailures = statuses.every(s => s.verified) ? 0 : Math.min((this.stockFailures ?? 0) + 1, 5);
      const ttl = statuses.every(s => s.verified && !s.availabilityWarning) ? 300_000
        : statuses.every(s => s.verified) ? 60_000 : 60_000 * 2 ** (this.stockFailures - 1);
      this.stocksCache = { at: Date.now(), ttl, value: statuses };
      return statuses;
    })();
    try {
      return await this.stocksPromise;
    } catch(error) {
      this.stockFailures=Math.min((this.stockFailures??0)+1,5);
      const value=this.assets.map(stock=>({...stock,verified:false,blockNumber:"unavailable",totalSupply:null,multiplierWad:null,error:`Asset verification is temporarily unavailable. ${redact(error,this.runtime.environment)}`}));
      this.stocksCache={at:Date.now(),ttl:60_000*2**(this.stockFailures-1),value};
      return value;
    } finally {
      this.stocksPromise = undefined;
    }
  }
  private async guardIdentity(address: Address, requiredVersion?: "vesting") {
    const chainId = deploymentChain(this.runtime.config), key = `${chainId}:${address.toLowerCase()}:${requiredVersion ?? "any"}`;
    const cache = this.guardCache ??= new Map(), requests = this.guardRequests ??= new Map();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
    if (requests.has(key)) return requests.get(key)!;
    const request = verifyLaunchGuardIdentity(this.client,address,chainId,requiredVersion,this.runtime.config.mode==="fork"?undefined:this.store).then(value => {
      cache.set(key, {at: Date.now(),ttl:Infinity,failures:0,value}); return value;
    }, () => {const failures=Math.min((cached?.failures??0)+1,5);cache.set(key,{at:Date.now(),ttl:60_000*2**(failures-1),failures,value:null});return null;});
    requests.set(key, request);
    try { return await request; } finally { requests.delete(key); }
  }
  async config(fresh=false): Promise<RuntimeConfig> {
    let config:RuntimeConfig;
    if(fresh){
      config=await this.readConfig(true);
      this.displayConfigCache={at:Date.now(),value:config};
    }
    else if(this.displayConfigCache&&Date.now()-this.displayConfigCache.at<60_000) config=this.displayConfigCache.value;
    else {
      const previous=this.displayConfigCache;
      this.displayConfigPromise??=this.readConfig(false).then(value=>{
        // A financial read may finish while this older display request is
        // pending. Never replace its newer verified snapshot with that result.
        if(this.displayConfigCache===previous)this.displayConfigCache={at:Date.now(),value};
        return value;
      }).finally(()=>{this.displayConfigPromise=undefined;});
      config=await this.displayConfigPromise;
    }
    // Cache the RPC graph only. Wallet requests and readiness reports must see
    // the current signing control once per caller, including cache hits.
    return this.currentSigningControl(structuredClone(config));
  }
  private async currentSigningControl(config:RuntimeConfig):Promise<RuntimeConfig> {
    if(this.runtime.config.mode==="fork")return config;
    try {
      const control=await this.store.runtimeControl();
      return {...config,controlRevision:control.revision,signingPaused:control.paused,
        ...(control.paused?{writesEnabled:false,blockReason:control.reason||"New signing is temporarily paused."}:{})};
    } catch {
      return {...config,signingPaused:true,writesEnabled:false,blockReason:"Signing controls are temporarily unavailable."};
    }
  }
  private async readConfig(fresh:boolean): Promise<RuntimeConfig> {
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
    let baseCollectorReady = this.runtime.config.mode === "fork";
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
        const verified = await verifyFeeEngine(this.client, this.feeEngineCandidate,undefined,{identityStore:this.store,fresh});
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
    if (this.feeEngineCandidate && deploymentChain(this.runtime.config) === 8453) {
      try {
        if (this.runtime.config.mode !== "fork") {
          const manifest = BASE_COLLECTOR_MANIFEST, treasury = manifest.constants.operationsTreasury;
          const fingerprint = baseCollectorGraphFingerprint(manifest);
          if (this.runtime.dataScope === "base" && manifest.collector.address && sameAddress(this.feeEngineCandidate, manifest.collector.address) &&
            this.runtime.config.treasury && treasury && sameAddress(this.runtime.config.treasury, treasury) &&
            await hasBaseLaunchActivationRecord(this.store, manifest, fingerprint)) {
            feeEngine = manifest.collector.address;
            baseCollectorReady = true;
            automationReceiver = manifest.constants.automationReceiver;
          }
        } else {
          await this.assertNetwork();
          const destination = this.baseDestinationClient ??= createPublicClient({ chain: robinhood, transport: http(mainnetRpcUrl(4663, this.runtime.environment), {
            batch: { batchSize: 20, wait: 0 }, timeout: 25_000, retryCount: 1,
          }), batch: { multicall: true } });
          const verified = await verifyBaseCollector(this.client, this.feeEngineCandidate, { requireActivation: "runtime", robinhoodClient: destination,auditStore:this.store });
          const treasury = BASE_COLLECTOR_MANIFEST.constants.operationsTreasury;
          if (this.runtime.config.treasury && treasury && sameAddress(this.runtime.config.treasury, treasury)) {
            feeEngine = verified.collector;
            baseCollectorReady = !verified.paused;
            automationReceiver = verified.automationReceiver;
          }
        }
      } catch { /* Deployment, reviewed wiring and owner activation authority are separate prerequisites. */ }
    }
    let writesEnabled = this.runtime.config.writesEnabled, blockReason = this.runtime.config.blockReason, controlRevision = 0, signingPaused = false;
    if (deploymentChain(this.runtime.config) === 8453 && !baseCollectorReady) {
      writesEnabled = false;
      blockReason = "Base issuance awaits its verified fee adapter, native Automation configuration and owner activation confirmation.";
    }
    const declaredNftMode = this.runtime.config.nftMode;
    return { ...this.runtime.config, writesEnabled, blockReason, controlRevision, signingPaused, securityProtocol: 1,
      curvePolicy: CURVE_POLICY, launchGuard, launchLockAvailable, feeEngine, buybackExecutor, automationReceiver, automationTreasury, wethForwarder, assetFeedOracle, buybackVault,
      // The declared factory is a candidate until its deployed runtime hash matches the manifest. The flag counts only with the database's
      // single-use guards in place, so a release check sees a flag-on runtime without the migration as a mismatch.
      ...(declaredNftMode ? { nftMode: { ...declaredNftMode, enabled: await this.nftModeEnabled(), vaultFactory: await this.verifiedVaultFactory() } } : {}) };
  }
  /** NFT mode as this runtime offers it: the flag is on AND the database enforces both single-use rules (TOKEN_UNIQUE_INDEXES; in Supabase,
   * migration 20261014120000). Without the guards NFT mode is off: `/config`, prepare, launch-fee quotes and the NFT APIs refuse, while
   * registration of coins already launched is never gated. */
  async nftModeEnabled(): Promise<boolean> {
    return this.runtime.config.nftMode?.enabled === true && await this.nftGuardsReady();
  }
  /** Whether the store's guard indexes exist. Ready lasts for the runtime's lifetime; not ready, or a failed read, is asked again after a minute,
   * so applying the migration enables NFT mode without a restart. */
  private async nftGuardsReady(): Promise<boolean> {
    const saved = this.nftGuardsCheck;
    if (saved && Date.now() - saved.at < saved.ttl) return saved.value;
    this.nftGuardsRequest ??= (async () => {
      const value = await Promise.resolve().then(() => this.store.nftGuardsReady()).then((ready) => ready === true, () => false);
      this.nftGuardsCheck = { at: Date.now(), ttl: value ? Infinity : 60_000, value };
      return value;
    })().finally(() => { this.nftGuardsRequest = undefined; });
    return this.nftGuardsRequest;
  }
  /** Identity check of the NFT fee-vault factory. A match or a foreign runtime lasts for the runtime's lifetime; empty code (not deployed yet,
   * or a lagging node) and an RPC failure only block for a minute, so neither can disable NFT mode until restart. */
  private async verifiedVaultFactory(): Promise<Address | null> {
    if (!this.runtime.config.nftMode?.vaultFactory) return null;
    const saved = this.nftFactoryCheck;
    if (saved && Date.now() - saved.at < saved.ttl) return saved.value;
    this.nftFactoryRequest ??= (async () => {
      try {
        await this.assertNetwork();
        const { factory, final } = await inspectVaultFactory(this.client, deploymentChain(this.runtime.config), this.runtime.nftVaultManifest);
        this.nftFactoryCheck = { at: Date.now(), ttl: final ? Infinity : 60_000, value: factory };
        return factory;
      } catch {
        this.nftFactoryCheck = { at: Date.now(), ttl: 60_000, value: null };
        return null;
      }
    })().finally(() => { this.nftFactoryRequest = undefined; });
    return this.nftFactoryRequest;
  }
  /** A platform-signed ETH price for the $10 launch fee, bound to the payer and valid for LAUNCH_FEE_QUOTE_TTL.
   * Fails closed without the plan-attestation key: Releases cannot add secrets, so that key signs these quotes too (under its own domain). */
  async launchFeeQuote(rawPayer: unknown) {
    const payer = addressSchema.parse(rawPayer), chainId = deploymentChain(this.runtime.config);
    if (!(await this.nftModeEnabled())) throw new NftLaunchError("NFT_MODE_DISABLED", "NFT launches are not enabled on this network.");
    const key = this.runtime.secrets?.planAttestationKey;
    if (!key) throw new NftLaunchError("NFT_FEE_INVALID", "ETH launch-fee quotes are unavailable on this deployment; pay with the stablecoin.");
    const weth = launchAssetsFor(this.runtime.config).find((asset) => asset.symbol === "WETH");
    if (!weth) throw new NftLaunchError("NFT_FEE_INVALID", "No ETH price reference on this network.");
    // The WETH opening valuation's quotePriceUsd is the USD price of one WETH (1 ETH), from the same LI.FI reference the launch itself uses.
    const { quotePriceUsd } = await this.openingValuation(weth.address);
    const priceWad = typeof quotePriceUsd === "string" && /^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/.test(quotePriceUsd) ? parseUnits(quotePriceUsd, 18) : 0n;
    if (priceWad <= 0n) throw new NftLaunchError("NFT_FEE_INVALID", "The ETH price is unavailable.");
    // Exact integer arithmetic, rounded up so a quote never undercharges the $10.
    const wei = ((BigInt(LAUNCH_FEE_USD) * 10n ** 36n + priceWad - 1n) / priceWad).toString();
    const expiresAt = Math.floor((Date.now() + LAUNCH_FEE_QUOTE_TTL) / 1000);
    const stable = LAUNCH_FEE_STABLE[chainId];
    return { wei, expiresAt, mac: launchFeeQuoteMac(key, chainId, payer, wei, expiresAt), stable: stable ? { address: stable.address, amount: String(stable.amount) } : null };
  }
  /** The fee was paid on-chain by `payer` to the platform treasury and has not already launched a coin (other than `self`, the coin being
   * registered or re-verified). Throws NFT_FEE_INVALID or NFT_FEE_USED; any other error is an RPC or configuration failure. */
  async assertUnusedLaunchFee(fee: LaunchFee, payer: Address, self?: Address): Promise<void> {
    const chainId = deploymentChain(this.runtime.config), treasury = this.runtime.config.treasury;
    if (!treasury) throw new Error("The platform treasury is not configured.");
    const keys = [this.runtime.secrets?.planAttestationKey, ...(this.runtime.secrets?.planAttestationPreviousKeys ?? [])].filter((k): k is string => !!k);
    await verifyLaunchFeePayment(this.client, { fee, payer, recipient: treasury, chainId, keys });
    if (await this.store.tokenUsingLaunchFee(fee.txHash, payer, self)) throw new NftLaunchError("NFT_FEE_USED", "This launch fee was already used.");
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
    const config = await this.config(true);
    this.assertLaunchPolicyCurrent(launchFeePolicy(config));
    if (isEngineFeePolicy(launchFeePolicy(config)) && !config.feeEngine)
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
  async prepare(raw: unknown, rawCreator: unknown, expectedCurvePolicy?: unknown, firstBuy?: unknown, rawOptions?: LaunchPrepareOptions, checkedConfig?: RuntimeConfig): Promise<LaunchPlan> {
    // This handshake must run before any RPC, including chain checks.
    if (expectedCurvePolicy !== CURVE_POLICY)
      throw new Error("The issuance curve policy has changed. Reload the launch page and run a new preview.");
    const draft = launchSchema.parse(raw), creator = addressSchema.parse(rawCreator),
      treasury = this.runtime.config.treasury;
    if (!treasury) throw new Error("The platform treasury is not configured.");
    if (!launchAssetsFor(this.runtime.config).some((asset) => sameAddress(asset.address, draft.quoteAddress)))
      throw new Error("This asset is unavailable for a new launch because it is not in the verified LI.FI opening-price pairing list.");
    assertNftDraftRules(draft, deploymentChain(this.runtime.config), this.runtime.config.nftMode?.enabled === true);
    // After the CPU-only rules: the flag counts only with the database's single-use guards in place.
    if (draft.nft && !(await this.nftModeEnabled())) throw new NftLaunchError("NFT_MODE_DISABLED", "NFT launches are not enabled on this network.");
    if (draft.nft && !this.runtime.config.nftMode?.vaultFactory)
      throw new NftLaunchError("NFT_VAULT_UNAVAILABLE", "The NFT fee vault is not deployed and verified on this network.");
    const stock = stockByAddress(draft.quoteAddress);
    const buy = firstBuySchema.parse(firstBuy);
    const options = prepareOptionsSchema.parse(rawOptions ?? {});
    const previous = options.previousPlanId ? await this.store.getPlan(options.previousPlanId) : null;
    if (options.previousPlanId && (!previous || previous.recovered || !sameAddress(previous.creator, creator) || !options.intentId || previous.intentId !== options.intentId ||
      !previous.prepared || !sameAddress(previous.draft.quoteAddress, draft.quoteAddress) ||
      previous.draft.tradingFeeBps !== draft.tradingFeeBps ||
      (previous.draft.nft?.chainId ?? null) !== (draft.nft?.chainId ?? null) ||
      (previous.draft.nft?.contract?.toLowerCase() ?? null) !== (draft.nft?.contract?.toLowerCase() ?? null) ||
      (previous.draft.nft?.tokenId ?? null) !== (draft.nft?.tokenId ?? null) ||
      (previous.draft.launchFee?.txHash ?? null) !== (draft.launchFee?.txHash ?? null) ||
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
    if (draft.nft) {
      const [control, existing] = await Promise.all([readNftControl(this.client, draft.nft, creator), this.store.verifiedNftCoin(nftKey(draft.nft))]);
      if (!control.erc721) throw new NftLaunchError("NFT_NOT_ERC721", "This contract is not an ERC-721 collection.");
      if (!control.controls) throw new NftLaunchError("NFT_NOT_CONTROLLED", "Connect the wallet that holds this NFT, or one it delegated to.");
      if (existing) throw new NftLaunchError("NFT_ALREADY_LAUNCHED", "This NFT already has its coin.");
      if (!isMuse(draft.nft) && !draft.launchFee) throw new NftLaunchError("NFT_FEE_REQUIRED", "Pay the $10 launch fee for this NFT first.");
      if (!isMuse(draft.nft)) await this.assertUnusedLaunchFee(draft.launchFee!, creator);
    }
    // The HTTP route already checked this request's live configuration. Reuse it
    // for read-only preparation; the actual signing validation reads it afresh.
    const launchConfig = checkedConfig ?? await this.config(true);
    // The live configuration exposes the factory only after its deployed runtime hash matched the manifest.
    if (draft.nft && !launchConfig.nftMode?.vaultFactory)
      throw new NftLaunchError("NFT_VAULT_UNAVAILABLE", "The NFT fee vault is not deployed and verified on this network.");
    const feePolicy = launchFeePolicy(launchConfig);
    this.assertLaunchPolicyCurrent(feePolicy);
    if (isEngineFeePolicy(feePolicy) && !launchConfig.feeEngine)
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
      previous?.prepared?.createParams.salt, chainId, launchConfig.feeEngine ?? undefined, false, undefined, this.runtime.nftVaultManifest);
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
    assertPlanIntegrity(plan, this.contracts, this.runtime.nftVaultManifest);
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
    assertPlanIntegrity(plan, this.contracts, this.runtime.nftVaultManifest);
    const config = await this.config(true);
    assertSigningEnabled(config);
    if (plan.firstBuy || isEngineFeePolicy(plan.feePolicy)) {
      if (isEngineFeePolicy(plan.feePolicy) && (!config.feeEngine || !plan.feeEngine || !sameAddress(config.feeEngine, plan.feeEngine)))
        throw new Error("The fee engine configuration changed or could not be verified. Run a new preview.");
      if (plan.firstBuy && (!config.launchGuard || !sameAddress(config.launchGuard, plan.firstBuy.guard)))
        throw new Error("The launch guard configuration changed or could not be verified. Run a new preview.");
      if (plan.firstBuy?.lockDays && !config.launchLockAvailable)
        throw new Error("The first buy lock guard could not be verified. Run a new preview.");
    }
    if (signing && plan.draft.nft) {
      // The kill switch stops new signatures too, not only new previews: NFT mode as prepare and /config see it (the flag and the
      // database guards), before any claim or protection. Registration of launches already sent is never gated.
      if (!(await this.nftModeEnabled())) throw new NftLaunchError("NFT_MODE_UNAVAILABLE", "NFT mode is not available on this network.");
      // Claims, re-reads and protects the plan; a failure in any step after the claim frees it.
      await this.claimNftLaunch(plan, plan.draft.nft);
    }
    // Simulation is still an unsigned preview. Protect only when the client is
    // entering a real wallet signature; unknown submissions must not age out.
    else if (signing) await this.store.protectPlan(plan.id);
    return { valid: true, feePolicy: plan.feePolicy, curvePolicy: plan.curvePolicy, planId: plan.id,
      validityVersion: plan.validityVersion, signingExpiresAt: plan.signingExpiresAt, intentId: plan.intentId, serverTime: Date.now() };
  }
  /** Before a real signature, an NFT plan claims its NFT and, unless it is a Muse, its fee payment in the database, all or nothing, for one
   * signing window from now (renewed each time the plan signs; held as submitted once its creation is sent; released by its registration).
   * The database's single-use indexes refuse a second coin only at registration, after both irreversible creations; the claim stops another
   * plan, in any tab or process, at signing. A plan that refreshes the holder (the plan signed after a first-buy approval, or a re-confirmed
   * price) takes over its unsubmitted claim through its verified lineage. Only once the plan holds its claim are both rules re-read, so a coin
   * registered since its preview is seen, and the plan is protected for signing; a failure in either authorizes nothing and frees the claim
   * at once. */
  private async claimNftLaunch(plan: LaunchPlan, nft: NftRef) {
    const fee = isMuse(nft) ? undefined : plan.draft.launchFee;
    if (!isMuse(nft) && !fee) throw new NftLaunchError("NFT_FEE_REQUIRED", "Pay the $10 launch fee for this NFT first.");
    const keys = nftLaunchKeys(nft, fee), expiresAt = Date.now() + LAUNCH_SIGNING_TTL;
    let held = await this.store.claimLaunch(plan.id, keys, expiresAt);
    const lineage = held.length && plan.previousPlanId ? await this.launchLineage(plan, keys) : [];
    if (lineage.length) held = await this.store.claimLaunch(plan.id, keys, expiresAt, { lineage });
    if (held.some((claim) => claim.startsWith("nft:")))
      throw new NftLaunchError("NFT_LAUNCH_IN_PROGRESS", "A launch for this NFT is already being signed. Finish it or wait a few minutes.");
    if (held.length) throw new NftLaunchError("NFT_FEE_IN_USE", "This launch fee is already attached to another launch being signed.");
    try {
      if (await this.store.verifiedNftCoin(nftKey(nft), plan.tokenAddress))
        throw new NftLaunchError("NFT_ALREADY_LAUNCHED", "This NFT already has its coin.");
      if (fee) await this.assertUnusedLaunchFee(fee, plan.creator, plan.tokenAddress);
      await this.store.protectPlan(plan.id);
    } catch (error) {
      // A claim held as submitted stays: this plan's creation was already sent.
      await this.releaseNftClaims(plan.id, { unsubmittedOnly: true });
      throw error;
    }
  }
  /** The earlier plans this one refreshes, nearest first: each server-stored `previousPlanId`, which prepare verified as the same creator,
   * NFT and fee (re-checked here). The walk stops at the first plan too old to still hold a signing claim (a plan signs only inside its
   * signing window and its claim lasts one window more); every earlier plan is older still. */
  private async launchLineage(plan: LaunchPlan, keys: string[]): Promise<string[]> {
    const lineage: string[] = [], oldest = Date.now() - 2 * LAUNCH_SIGNING_TTL;
    for (let id = plan.previousPlanId; id && id !== plan.id && !lineage.includes(id);) {
      const previous = await this.store.getPlan(id);
      if (!previous || previous.recovered || !previous.draft.nft || !sameAddress(previous.creator, plan.creator) || previous.preparedAt < oldest ||
        nftLaunchKeys(previous.draft.nft, isMuse(previous.draft.nft) ? undefined : previous.draft.launchFee).join() !== keys.join()) break;
      lineage.push(id);
      id = previous.previousPlanId;
    }
    return lineage;
  }
  /** The wallet sent this NFT plan's creation: its claims are held as submitted, never taken over or moved, for one recovery window from now,
   * until registration or a proven revert releases them (reconcile renews them while the creation may still be mined). Throws when the
   * database could not store the mark. A claim another plan already holds (this creation was sent after its signing claim expired) is left
   * to registration, which settles the conflict; `report` logs it. */
  private async markNftClaimsSubmitted(plan: LaunchPlan, hash: Hex, report = true) {
    const nft = plan.draft.nft!;
    const held = await this.store.claimLaunch(plan.id, nftLaunchKeys(nft, isMuse(nft) ? undefined : plan.draft.launchFee),
      Date.now() + RECOVERY_RESULT_TTL_MS, { submitted: true });
    if (held.length && report) console.error(JSON.stringify({ event: "nft_launch_claim_lost", planId: plan.id, hash, held }));
  }
  /** Tracking reports success only once the mark is stored: three attempts with the RPC transport's short backoff (250 ms, then 500 ms),
   * then LaunchClaimUnavailable, a 503 the client's API layer retries. The hash is already queued, so the next reconcile pass marks it too. */
  private async trackNftClaims(plan: LaunchPlan, hash: Hex) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.markNftClaimsSubmitted(plan, hash); }
      catch (error) {
        if (attempt < 2) { await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt)); continue; }
        console.error(JSON.stringify({ event: "nft_launch_claim_submit_failed", planId: plan.id, hash, error: error instanceof Error ? error.message : String(error) }));
        throw new LaunchClaimUnavailable();
      }
    }
  }
  /** Reconcile's defense in depth, for a queued creation that has not settled (no receipt yet, an unreadable one, or a registration that is
   * still retrying): holds its NFT plan's claims as submitted for another recovery window from this pass, never taking another plan's. Not
   * once the launch registered (its claims were released) or reverted (it left the queue), and not while the node has no trace of the
   * transaction: an evicted or replaced creation, which reconcile otherwise keeps forever, then lapses within one window instead of locking
   * the NFT. Best-effort. */
  private async renewPendingNftClaims(row: { hash: Hex; planId: string; status: string }, error: unknown) {
    try {
      if (row.status !== "pending" || await this.store.tokenByTxHash(row.hash)) return;
      if (error instanceof TransactionReceiptNotFoundError &&
        !await this.client.getTransaction({ hash: row.hash }).then(() => true, (failure: unknown) => !(failure instanceof TransactionNotFoundError))) return;
      const plan = await this.store.getPlan(row.planId);
      if (plan?.draft.nft) await this.markNftClaimsSubmitted(plan, row.hash, false);
    } catch { /* The claim keeps its current expiry; the next pass tries again. */ }
  }
  /** Frees a plan's claims; a failure only leaves them to expire. */
  private async releaseNftClaims(planId: string, options?: { unsubmittedOnly?: boolean }) {
    await Promise.resolve().then(() => this.store.releaseLaunchClaims(planId, options)).catch((error: unknown) =>
      console.error(JSON.stringify({ event: "nft_launch_claims_release_failed", planId, error: error instanceof Error ? error.message : String(error) })));
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
    if (plan.draft.nft) await this.trackNftClaims(plan, hash);
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
    if (isEngineFeePolicy(feePolicy)) return;
    if (deploymentChain(this.runtime.config) === 8453 && this.runtime.config.mode !== "fork")
      throw new Error("New Base launches require the verified native Automation fee adapter.");
    const cutover = this.launchCutover();
    if (cutover && Date.now() >= cutover.timestamp * 1000)
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
  /** One shared check per key. Success is kept for `successTtl`; a verdict
   * that cannot change (a guard that is not the pinned runtime, or a price
   * anchor contradicted at a finalized block) for ten minutes; one that still
   * could (a non-final anchor, an RPC failure, a reorganization seen
   * mid-read) briefly; a capacity refusal not at all, so the next request
   * competes again. */
  private remembered(checks: Map<string, RememberedCheck>, key: string, successTtl: number, work: () => Promise<void>): Promise<void> {
    const now = Date.now(), known = checks.get(key);
    if (known && (known.settledAt === undefined || now - known.settledAt < known.ttl)) return known.promise;
    if (checks.size >= 10_000)
      for (const [stale, entry] of checks) if (entry.settledAt !== undefined && now - entry.settledAt >= entry.ttl) checks.delete(stale);
    const entry: RememberedCheck = { promise: Promise.resolve(), ttl: 0 };
    entry.promise = work().then(() => { entry.settledAt = Date.now(); entry.ttl = successTtl; }, async (error: unknown) => {
      const final = error instanceof LaunchGuardMismatch || error instanceof RecoveryEvidenceError &&
        (error.finalAt === undefined || await this.finalizedThrough(error.finalAt));
      entry.settledAt = Date.now();
      entry.ttl = final ? RECOVERY_RESULT_TTL_MS : error instanceof BudgetUnavailable ? 0 : RECOVERY_TRANSIENT_RETRY_MS;
      throw error;
    });
    checks.set(key, entry);
    return entry.promise;
  }
  /** The price anchor a backup names, checked before the shared budget: one
   * block read per claimed anchor, shared and remembered, so a contradicted
   * anchor never takes a budget slot however often it is resubmitted. */
  private recoveryAnchor(valuation: OpeningValuation): Promise<void> {
    const blockNumber = BigInt(valuation.blockNumber);
    return this.remembered(this.anchorChecks ??= new Map(), `${blockNumber}:${valuation.blockHash.toLowerCase()}`, RECOVERY_TRANSIENT_RETRY_MS, async () => {
      const block = await this.client.getBlock({ blockNumber });
      if (!block.hash || block.hash.toLowerCase() !== valuation.blockHash.toLowerCase())
        throw new RecoveryEvidenceError("The recovered opening valuation is not anchored to a canonical block.", blockNumber);
    });
  }
  /** Chain evidence for a recovered preview that already re-encodes the
   * transaction exactly. Every input here (opening valuation, guard, token) is
   * fixed by that transaction's calldata, so any backup reaching this point
   * shares one in-flight check and its cached result per transaction and
   * receipt block. Altered backups fail re-encoding first and never reach it,
   * so they can neither spend the shared budget nor delay the correct backup;
   * neither can a guard already found not to be the pinned runtime. */
  private recoveryEvidence(hash: Hex, plan: LaunchPlan, receipt: { blockNumber: bigint; blockHash: Hex }): Promise<void> {
    const guard = plan.firstBuy ? { address: plan.firstBuy.guard, version: plan.firstBuy.lockDays ? "vesting" as const : undefined } : undefined;
    // A nonempty foreign runtime is fake for every requested guard version.
    const guardKey = guard?.address.toLowerCase();
    const mismatches = this.guardMismatches ??= new Map(), seen = guardKey ? mismatches.get(guardKey) : undefined;
    if (seen !== undefined && Date.now() - seen < RECOVERY_RESULT_TTL_MS)
      return Promise.reject(new LaunchGuardMismatch("The launch guard runtime or official dependencies do not match the pinned deployment."));
    const chainId = deploymentChain(this.runtime.config);
    // Evidence is judged at the receipt block. A transaction re-mined in
    // another block after a reorganization is a different key, checked afresh.
    return this.remembered(this.recoveryChecks ??= new Map(), `${hash}:${receipt.blockHash.toLowerCase()}`, RECOVERY_RESULT_TTL_MS,
      () => this.withRecoveryVerification(async () => {
        const reference = await assertRecoveredOpeningValuation(this.client, plan.openingValuation!, receipt.blockNumber, chainId);
        // Advisory, like the review-time warning; provenance is decided by attestation.
        if (reference && reference.divergenceBps > LIFI_OPENING_MAX_DIVERGENCE_BPS)
          console.warn(JSON.stringify({ event: "recovery_reference_divergence", transactionHash: hash, token: plan.tokenAddress, divergenceBps: reference.divergenceBps }));
        if (guard) await verifyLaunchGuardIdentity(this.client, guard.address, chainId, guard.version,this.runtime.config.mode==="fork"?undefined:this.store).catch((error: unknown) => {
          // Every transaction through a guard that is not the pinned runtime
          // shares this verdict, refused before the budget from now on.
          if (error instanceof LaunchGuardMismatch) {
            if (mismatches.size >= 10_000) mismatches.clear();
            mismatches.set(guardKey!, Date.now());
          }
          throw error;
        });
        // The reads above are by block number; keep their verdict only for the
        // receipt block they actually saw.
        const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
        if (!block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
          throw new Error("The receipt block was reorganized. Wait for confirmation again.");
      }));
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
    // The official Airlock's own event, read from the receipt in hand: a
    // transaction that never created this token through it is refused before
    // any further RPC or shared recovery budget.
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
    if (!savedPlan) {
      // A backup's fee routing must also be platform-approved before that work.
      if (keccak256(plan.data) !== plan.id) throw new Error("The creation receipt does not match the preview's outer transaction.");
      // Treasury-only routing after a recorded engine cutover is judged by the
      // receipt's canonical block time; nothing else needs that block yet.
      const cutover = plan.feePolicy === FEE_POLICY ? this.launchCutover() : undefined;
      let timestamp = 0n, baseDeploymentTimestamp: bigint | undefined;
      if (plan.feePolicy === FEE_POLICY && deploymentChain(this.runtime.config) === 8453 && BASE_COLLECTOR_MANIFEST.status === "deployed_verified") {
        const collector = BASE_COLLECTOR_MANIFEST.collector;
        if (!collector.transactionHash || !collector.blockNumber || !collector.address) throw new Error("The Base fee cutover deployment is incomplete.");
        const deploymentReceipt = await this.client.getTransactionReceipt({ hash: collector.transactionHash });
        const deploymentBlock = await this.client.getBlock({ blockNumber: BigInt(collector.blockNumber) });
        if (deploymentReceipt.status !== "success" || deploymentReceipt.blockNumber !== BigInt(collector.blockNumber) ||
          !deploymentReceipt.contractAddress || !sameAddress(deploymentReceipt.contractAddress, collector.address) ||
          deploymentBlock.hash !== deploymentReceipt.blockHash || deploymentBlock.timestamp <= 0n)
          throw new Error("The Base fee cutover deployment is not canonical; old preview recovery is withheld.");
        baseDeploymentTimestamp = deploymentBlock.timestamp;
      }
      if (cutover || baseDeploymentTimestamp !== undefined) {
        if (cutover) await this.assertCanonicalCutover(cutover);
        const receiptBlock = await this.client.getBlock({ blockNumber: receipt.blockNumber });
        if (receiptBlock.hash !== receipt.blockHash) throw new Error("The receipt block was reorganized. Wait for confirmation again.");
        timestamp = receiptBlock.timestamp;
      }
      assertTrustedLaunchPolicy(plan, this.runtime.config, { blockNumber: receipt.blockNumber, timestamp },
        trustedLaunchPolicies(this.runtime.config, this.launchManifest(), BASE_COLLECTOR_MANIFEST, baseDeploymentTimestamp));
      // CPU only: an altered backup fails here, before any shared RPC budget.
      assertRecoveryPlan(plan, this.contracts, this.sdk, this.runtime.nftVaultManifest);
      if (BigInt(plan.openingValuation!.blockNumber) > receipt.blockNumber)
        throw new Error("The recovered opening valuation is newer than its creation receipt.");
      await this.recoveryAnchor(plan.openingValuation!);
      await this.recoveryEvidence(hash, plan, receipt);
    }
    if (plan.openingValuation)
      assertHistoricalOpeningValuation(plan.openingValuation, plan.draft.quoteAddress, deploymentChain(this.runtime.config));
    if (plan.prepared) {
      const verified = await verifyPreparedCreateExecution({ prepared: restorePrepared(plan.prepared), receipt, publicClient: this.client });
      if (plan.firstBuy) verifyGuardedReceipt(plan, receipt, verified.devBuy?.amountOut);
    } else if (plan.firstBuy) throw new Error("The guarded creation snapshot is missing.");
    if (savedPlan) await this.store.trackLaunch(hash, plan.id);
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
    // A launch fee is persisted only after it verifies below; the draft's own is only a claim (a backup can name anyone's payment).
    const { launchFee: _claimedFee, ...listing } = draft;
    const token: TokenRecord = {
      ...listing,
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
      // previous key added later can still verify it. Only a verified one may
      // replace a stored backup; otherwise the first stored stays, so a
      // concurrent or later stripped or forged copy cannot drop it.
      const kept = attestation ?? plan.attestation;
      const recovered: LaunchPlan = { ...restored, recovered: true, ...(kept ? { attestation: kept } : {}) };
      await (attestation ? this.store.savePlan(recovered) : this.store.savePlanIfAbsent(recovered));
      await this.store.protectPlan(plan.id); await this.store.trackLaunch(hash, plan.id);
    }
    // A token is written once, and its provenance may only improve: a launch
    // first registered from an unattested backup becomes verified once an
    // attested backup or a retained key proves its opening valuation, in
    // whichever order concurrent registrations land.
    let record = token;
    const save = async () => { await this.store.saveToken(record); await this.store.upgradeTokenProvenance(record); };
    if (!draft.nft) await save();
    else {
      const nft = draft.nft, fee = isMuse(nft) ? undefined : draft.launchFee;
      // The creation is on-chain: its claims hold, as submitted, while registration decides (it can retry for minutes). Best-effort:
      // registration is never blocked by claims.
      await this.markNftClaimsSubmitted(plan, hash).catch((error: unknown) => console.error(JSON.stringify({ event: "nft_launch_claim_submit_failed",
        planId: plan.id, hash, error: error instanceof Error ? error.message : String(error) })));
      // The one-coin and single-use checks hold until the record that makes them true is written.
      await withNftLocks(nftLaunchKeys(nft, fee), async () => {
        const settled = await this.nftRegistration({ hash, plan, nft, fee, saved: !!savedPlan, receiptBlock: receipt.blockNumber, receiptTimestamp: block.timestamp });
        record = { ...token, nft, nftVerification: settled.nftVerification, ...(settled.launchFee ? { launchFee: settled.launchFee } : {}) };
        // Another process (`nft:reverify`, another runtime) may have spent this fee or verified this NFT's coin since the checks above; the
        // database then refuses the write. That is the status the checks would have given had they seen it: a used fee is `rejected: fee`
        // and spends nothing, an NFT that has its coin is `rejected: already_launched` (a paid fee stays spent, as at registration). The coin
        // still registers. Each refusal removes the conflicting claim, so at most two refusals precede the write.
        for (let refusals = 0; ; refusals++) {
          try { await save(); break; } catch (error) {
            if (!(error instanceof TokenUniqueConflict) || refusals === 2) throw error;
            const rejected = { status: "rejected" as const, reason: error.kind === "launch_fee" ? "fee" : "already_launched",
              ...(savedPlan ? {} : { block: String(receipt.blockNumber) }) };
            const { launchFee: spent, ...rest } = record;
            record = { ...rest, nftVerification: rejected, ...(spent && error.kind === "nft_verified" ? { launchFee: spent } : {}) };
          }
        }
      });
      // The launch is decided, verified or rejected: its claims are freed. Registration never reads claims.
      await this.releaseNftClaims(plan.id);
    }
    this.invalidateTokens();
    await this.store.launchStatus(hash, "confirmed", receipt.blockHash);
    return await this.store.tokenByTxHash(hash) ?? record;
  }
  /** An NFT coin's status and the launch fee it consumed, decided once at registration. The caller holds the NFT's and the payment's locks
   * until the record is written. Register never blocks on the status rules; it fails retryably only while an RPC outage, or a fee payment
   * that is not found, still confirming or in a reorganized block, is under 10 minutes old (spec §6.2). */
  private async nftRegistration(args: { hash: Hex; plan: LaunchPlan; nft: NftRef; fee?: LaunchFee; saved: boolean; receiptBlock: bigint; receiptTimestamp: bigint }):
    Promise<{ nftVerification: NftRegistrationStatus; launchFee?: LaunchFee }> {
    // A record already written for this transaction keeps its status and fee: a repeated or concurrent registration, or a later attested
    // backup upgrading provenance, never decides it again.
    const stored = await this.store.tokenByTxHash(args.hash);
    if (stored?.nftVerification) return { nftVerification: stored.nftVerification, ...(stored.launchFee ? { launchFee: stored.launchFee } : {}) };
    const { plan, nft } = args, nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    let fee: RegistrationFee | undefined;
    const claim = !isMuse(nft) && args.fee ? { ...args.fee, txHash: args.fee.txHash.toLowerCase() as Hex } : undefined;
    if (!isMuse(nft)) {
      // Prepare refuses without a treasury, but registration (a saved preview or a backup) can still meet it: the fee cannot be checked.
      if (claim && !this.runtime.config.treasury)
        console.error(JSON.stringify({ event: "nft_fee_treasury_unconfigured", transactionHash: args.hash, token: plan.tokenAddress }));
      // A definite mismatch or a used payment only costs the status. Anything that can still change retries for 10 minutes; then a
      // transaction the chain does not have is `rejected: fee`, and an unconfirmed or unreadable payment leaves the coin `unverified`.
      const settled = claim ? await settleLaunchFee(() => this.assertUnusedLaunchFee(claim, plan.creator, plan.tokenAddress), args.receiptTimestamp, nowSeconds) : "invalid";
      if (settled === "retry") throw new Error("The launch fee check is temporarily unavailable. Registration will retry.");
      fee = settled;
    }
    const launchFee = fee === "paid" ? claim : undefined;
    // Control can only be shown on the NFT's own chain. Prepare refuses another chain, so only a backup can carry one.
    const result = nft.chainId !== deploymentChain(this.runtime.config) ? { status: "rejected" as const, reason: "not_controller" }
      : await nftRegistrationStatus({ client: this.client, nft, creator: plan.creator,
        // Saved previews read the latest block (registration makes no historical-state read); backups read the receipt block.
        blockNumber: args.saved ? undefined : args.receiptBlock,
        existing: await this.store.verifiedNftCoin(nftKey(nft), plan.tokenAddress),
        quoteAddress: plan.draft.quoteAddress, receiptTimestamp: args.receiptTimestamp, nowSeconds, ...(fee ? { fee } : {}) });
    if (result === "retry") throw new Error("The NFT ownership check is temporarily unavailable. Registration will retry.");
    // An unconfirmed fee stays unspent; the coin keeps its claim so `npm run nft:reverify` can settle it later.
    const settledStatus: NftRegistrationStatus = fee === "unconfirmed" && claim && result.status === "unverified" ? { ...result, feeClaim: claim } : result;
    const nftVerification = settledStatus.status === "verified" || args.saved ? settledStatus : { ...settledStatus, block: String(args.receiptBlock) };
    return { nftVerification, ...(launchFee ? { launchFee } : {}) };
  }
  private reconciling = false;
  private reconcileCursor?: Hex;
  async reconcile(maxDurationMs = 60_000) {
    if (this.reconciling) return;
    this.reconciling = true;
    const deadline = Date.now() + maxDurationMs;
    try {
      // Ordinary maintenance recovers launches only; empty queues need no RPC.
      const pending = await this.store.pendingLaunches();
      if (pending.length === 0) return;
      await this.assertNetwork();
      const rows = pending;
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
            // The creation reverted in a canonical, confirmed block: it launched nothing, so its NFT and fee are free again.
            const failed = await Promise.resolve().then(() => this.store.getPlan(row.planId)).catch(() => null);
            if (failed?.draft.nft) await this.releaseNftClaims(failed.id);
          } else await this.register(row.hash);
        } catch (error) {
          /* Upstream absence or timeout is not evidence of failure. Retry after restart or next tick. */
          await this.renewPendingNftClaims(row, error);
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
  /** The NFT surfaces stay dark while NFT mode is off (the flag, or the database's single-use guards): refused before any parsing or RPC, and
   * with the flag off before any database read. */
  private async assertNftModeAvailable() {
    if (!(await this.nftModeEnabled())) throw new NftLaunchError("NFT_MODE_UNAVAILABLE", "NFT mode is not available on this network.");
  }
  /** An NFT's fee vault and Tokenbound treasury: both addresses are computed and checked for code; the balances are what the treasury and the
   * vault hold of the NFT's bound coins (any status) and their paired assets (a failed vault read is `vaultAmount: null`; an asset whose treasury read
   * failed is left out; neither is ever shown as zero); the pending fees are the vault's per coin, and one coin's failed preview becomes an
   * error entry instead of failing the answer. Public and keyed by user input, so a fully successful result is kept in memory for 15 seconds,
   * within a bounded cache; a degraded one is returned but never cached. */
  async nftTreasury(raw: unknown): Promise<NftTreasury> {
    await this.assertNftModeAvailable();
    const nft = parseNftQuery(raw), chainId = deploymentChain(this.runtime.config);
    if (nft.chainId !== chainId) throw new NftLaunchError("NFT_CHAIN_UNSUPPORTED", "This NFT lives on another network; open it there.");
    const factory = await this.verifiedVaultFactory();
    if (!factory) throw new NftLaunchError("NFT_VAULT_UNAVAILABLE", "The NFT fee vault is not deployed and verified on this network.");
    const key = nftKey(nft), saved = NFT_TREASURY_CACHE.get(key);
    if (saved && Date.now() - saved.at < NFT_TREASURY_TTL_MS) return saved.value;
    const vault = vaultFor(nft, factory, this.runtime.nftVaultManifest?.vaultInitCodeHash), treasury = treasuryFor(nft);
    // Every coin bound to this NFT, whatever its status: a rejected coin still pays the vault, so its balances, fees and sweep belong here.
    const coins = (await this.tokens()).filter((record) => !!record.nft && nftKey(record.nft) === key);
    const assets = new Map<string, { token: Address; symbol: string }>();
    for (const coin of coins) assets.set(coin.address.toLowerCase(), { token: coin.address, symbol: coin.symbol });
    for (const coin of coins) {
      const quote = quoteAsset(coin);
      if (!assets.has(quote.address.toLowerCase())) assets.set(quote.address.toLowerCase(), { token: quote.address, symbol: quote.symbol });
    }
    const listed = [...assets.values()];
    const reads = listed.flatMap(({ token }) => [treasury, vault].map((holder) => ({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] }) as const));
    const [vaultCode, treasuryCode, held, previews] = await Promise.all([
      this.client.getCode({ address: vault }), this.client.getCode({ address: treasury }),
      reads.length ? this.client.multicall({ contracts: reads, allowFailure: true }) : Promise.resolve([]),
      Promise.allSettled(coins.map((coin) => this.fees(coin.address, vault))),
    ]);
    const balances = listed.flatMap((asset, index) => {
      const inTreasury = held[2 * index], inVault = held[2 * index + 1];
      return inTreasury?.status === "success"
        ? [{ ...asset, amount: String(inTreasury.result), vaultAmount: inVault?.status === "success" ? String(inVault.result) : null }] : [];
    });
    const pendingFees = previews.map((preview, index) => preview.status === "fulfilled" ? { token: coins[index].address, ...preview.value }
      : { token: coins[index].address, error: redact(preview.reason, this.runtime.environment) });
    const hasCode = (code: Hex | undefined) => !!code && code !== "0x";
    const value: NftTreasury = { nft, vault, vaultDeployed: hasCode(vaultCode), treasury, treasuryDeployed: hasCode(treasuryCode),
      coins: coins.map((coin) => ({ token: coin.address, symbol: coin.symbol, poolId: coin.poolId, quoteAddress: coin.quoteAddress })), balances, pendingFees };
    // A degraded answer (a failed balance read or fee preview) is returned, but the next request asks the chain again.
    if (held.some((read) => read.status !== "success") || previews.some((preview) => preview.status !== "fulfilled")) return value;
    const now = Date.now();
    // Entries are inserted in time order, so the expired ones are at the front; then the oldest go once the cap is reached.
    for (const [cached, row] of NFT_TREASURY_CACHE) { if (now - row.at < NFT_TREASURY_TTL_MS) break; NFT_TREASURY_CACHE.delete(cached); }
    NFT_TREASURY_CACHE.delete(key);
    while (NFT_TREASURY_CACHE.size >= NFT_TREASURY_CACHE_MAX) NFT_TREASURY_CACHE.delete(NFT_TREASURY_CACHE.keys().next().value!);
    NFT_TREASURY_CACHE.set(key, { at: now, value });
    return value;
  }
  /** What the create form needs to know about an NFT for `account`: ERC-721, holder or delegate, whether it already has its verified coin,
   * and whether it launches free (a Muse). Prepare re-checks all of it. A Muse also gets its name and agent id; each successful read is kept
   * for the runtime's lifetime (so the memory is bounded by the Muses supply), a failed one is left out and asked again next time. */
  async nftStatus(rawNft: unknown, rawAccount: unknown): Promise<NftStatus> {
    await this.assertNftModeAvailable();
    const nft = parseNftQuery(rawNft), account = addressSchema.parse(rawAccount);
    if (nft.chainId !== deploymentChain(this.runtime.config)) throw new NftLaunchError("NFT_CHAIN_UNSUPPORTED", "This NFT must launch on its own network.");
    await this.assertNetwork();
    const free = isMuse(nft), profiles = this.museProfiles ??= new Map(), saved = profiles.get(nft.tokenId) ?? {};
    const [control, existing, name, agentId] = await Promise.all([readNftControl(this.client, nft, account), this.store.verifiedNftCoin(nftKey(nft)),
      free ? saved.name ?? readMuseName(this.client, nft) : undefined, free ? saved.agentId ?? readMuseAgentId(this.client, nft) : undefined]);
    const profile = { ...(name ? { name } : {}), ...(agentId ? { agentId } : {}) };
    if (name || agentId) profiles.set(nft.tokenId, profile);
    return { ...control, alreadyLaunched: !!existing, free, ...profile };
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
    if (!isEngineFeePolicy(token.feePolicy) || !token.feeEngine || !sameAddress(token.feeEngine, engine))
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
// Per-NFT and per-payment registration locks. Module-level because refreshRuntime rebuilds the service; in-process only (the Worker routes
// each chain to one Durable Object). Keys are taken in sorted order, so registrations that share keys cannot deadlock. Across processes the
// database's guard indexes (TOKEN_UNIQUE_INDEXES) refuse the second write; these locks only let one process decide in order.
const NFT_LOCKS = new Map<string, Promise<void>>();
/** The keys of one NFT launch: its NFT and, for a paid NFT, its fee payment. Shared by the registration locks and the pre-sign claims. */
function nftLaunchKeys(nft: NftRef, fee?: LaunchFee): string[] {
  return [`nft:${nftKey(nft)}`, ...(fee ? [`fee:${fee.txHash.toLowerCase()}`] : [])];
}
async function withNftLocks<T>(keys: string[], run: () => Promise<T>): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const key of [...new Set(keys)].sort()) {
      const previous = NFT_LOCKS.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; }), tail = previous.then(() => current);
      NFT_LOCKS.set(key, tail);
      releases.push(() => { release(); if (NFT_LOCKS.get(key) === tail) NFT_LOCKS.delete(key); });
      await previous;
    }
    return await run();
  } finally { for (const release of releases.reverse()) release(); }
}
// /api/* is no-store, so the public treasury view is cached here. Keys come from user input: fully successful results only, at most 500 of them.
// `coins`: every coin bound to the NFT, whatever its status, with what a sweep needs (its pool and both assets).
type NftTreasury = { nft: NftRef; vault: Address; vaultDeployed: boolean; treasury: Address; treasuryDeployed: boolean;
  coins: { token: Address; symbol: string; poolId: Hex; quoteAddress: Address }[];
  balances: { token: Address; symbol: string; amount: string; vaultAmount: string | null }[]; pendingFees: unknown[] };
const NFT_TREASURY_TTL_MS = 15_000, NFT_TREASURY_CACHE_MAX = 500;
const NFT_TREASURY_CACHE = new Map<string, { at: number; value: NftTreasury }>();
// A transaction's settled chain evidence at one receipt block is reused for
// this long; a failure that could still change only briefly, so a later retry
// can succeed.
const RECOVERY_RESULT_TTL_MS = 600_000;
const RECOVERY_TRANSIENT_RETRY_MS = 15_000;
type RememberedCheck = { promise: Promise<void>; settledAt?: number; ttl: number };
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
