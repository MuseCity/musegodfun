import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, decodeEventLog, erc20Abi, http, parseAbi, parseAbiItem, type PublicClient, type Transport, type TransactionReceipt } from "viem";
import { base } from "viem/chains";
import { setTimeout as waitForPropagation } from "node:timers/promises";
import { ENGINE_FEE_POLICY, BASE_AUTOMATION_FEE_POLICY, FEE_POLICY } from "../src/lib/fee-policy";
import baseCollectorDeployment from "../contracts/artifacts/base-collector-deployment.json";
import { baseCollectorGraphFingerprint, verifyBaseCollectorForOperator as verifyBaseCollector, type BaseCollectorManifest } from "../server/base-collector";
import { mainnetRpcUrl } from "../server/config";
import { STOCKS } from "../src/lib/config";
import { BASE_BUYBACK_WETH, BASE_RECOVERY_PROTOCOL, BASE_NATIVE_DESTINATION_POLICY } from "../src/lib/base-buyback";
import { baseOperatorAuditStore } from "./base-audit-store";
import type { BaseAuditStore } from "../server/base-audit";
import type { BuildInfo } from "../src/lib/build-info";
import { readBuildIdentity, REPOSITORY } from "./build-info";
import { assertBuildManifest, assertCandidateRuntimeBindings, assertFrozenBuild, assertLaunchRuntime, assertReleaseCheckout, assertSecurityTransition, rollbackPreservesSafety, publishCandidate, ReleaseFailure, requireSingleActiveVersion, runtimeVarsFromBindings, sha256, snapshotBuild } from "./release-policy";

const repositorySlug = "MuseCity/musegodfun", workerName = "musegod-fun";
const origins = ["https://musegod.fun", "https://www.musegod.fun"];
const apiVersion = "2026-03-10";

// CI tolerates bounded edge and DO code propagation. The standalone verifier stays strict.
export async function verifyProductionCandidate(candidate: string, checks: {
  activeVersion(): Promise<string>;
  assertFrozen(): void;
  verifyOrigin(origin: string): Promise<void>;
  describe(message: string): void;
  wait(milliseconds: number): Promise<unknown>;
}): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    checks.assertFrozen();
    if (await checks.activeVersion() !== candidate) throw new Error("Candidate changed before production verification");
    let passed = false, failure: unknown;
    try {
      // Restart the whole pair on every attempt; results from different rounds cannot be combined.
      for (const origin of origins) await checks.verifyOrigin(origin);
      passed = true;
    } catch (error) { failure = error; }
    // Source/artifact changes and external activations never enter the retry path.
    checks.assertFrozen();
    if (await checks.activeVersion() !== candidate) throw new Error("Candidate changed during production verification");
    if (passed) return;
    const reason = failure instanceof Error ? failure.message : String(failure);
    checks.describe(`Production verification attempt ${attempt}/3 failed: ${reason}${attempt < 3 ? "; retrying both origins in 60 seconds" : "; retry budget exhausted"}`);
    if (attempt === 3) throw new Error("Production verification failed after 3 complete attempts", { cause: failure });
    await checks.wait(60_000);
  }
}

interface ReleaseAsset { id: number; name: string; digest: string; state: string; browser_download_url: string }
interface GitHubRelease { id: number; upload_url: string; tag_name: string; target_commitish: string; draft: boolean; immutable: boolean; html_url: string; assets: ReleaseAsset[] }
interface WorkerVersion {
  id: string;
  annotations?: Record<string, string>;
  resources: { bindings: { name: string; type: string; [key: string]: unknown }[]; script?: { migration_tag?: string } };
}
interface WranglerConfig {
  name: string; account_id: string; assets: { directory: string };
  migrations?: { tag: string }[]; build?: unknown; exports?: unknown;
  vars: Record<string, string>;
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}; automatic publication must run in the configured GitHub workflow`);
  return value;
};

function frozenBuild() {
  const identity = readBuildIdentity();
  if (identity.source !== "github-actions" || !identity.buildId || !identity.runUrl || !identity.releaseUrl)
    throw new Error("Production publication only accepts a clean GitHub Actions master push build");
  assertReleaseCheckout(required("GITHUB_SHA"), git("rev-parse", "HEAD"), git("status", "--porcelain", "--untracked-files=all"));
  const directory = resolve("dist"), frozen = snapshotBuild(directory);
  const info = JSON.parse(readFileSync(join(directory, "build-info.json"), "utf8")) as BuildInfo;
  for (const [key, value] of Object.entries(identity)) {
    if (info[key as keyof BuildInfo] !== value) throw new Error(`Frozen build identity differs from the checkout: ${key}`);
  }
  assertBuildManifest(info, frozen);
  return { identity, info, directory, frozen };
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} for ${new URL(url).origin}${new URL(url).pathname}`), { status: response.status });
  return response;
}

async function github<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await request(`https://api.github.com/repos/${repositorySlug}/${path}`, {
    method,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${required("GITHUB_TOKEN")}`, "X-GitHub-Api-Version": apiVersion, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return await response.json() as T;
}

async function cloudflare<T>(account: string, path: string): Promise<T> {
  const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/${path}`, {
    headers: { Authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}` },
  });
  const data = await response.json() as { success: boolean; result: T };
  if (!data.success || !data.result) throw new Error(`Cloudflare read-back failed for ${path}`);
  return data.result;
}

// Only the version just reported by the successful upload may be temporarily absent.
// Retry its read-back, never the upload or any publication/activation operation.
export async function readUploadedCandidate(account: string, version: string,
  wait: (milliseconds: number) => Promise<unknown> = waitForPropagation): Promise<WorkerVersion> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await cloudflare<WorkerVersion>(account, `scripts/${workerName}/versions/${version}`); }
    catch (error) {
      if (!(error instanceof Error) || !("status" in error) || error.status !== 404 || attempt === 3) throw error;
      await wait(10_000);
    }
  }
  throw new Error("Candidate version read-back retry budget exhausted");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertPreservedBindings(previous: WorkerVersion, candidate: WorkerVersion) {
  const select = (version: WorkerVersion, type: string) => version.resources.bindings.filter(binding => binding.type === type).sort((a, b) => a.name.localeCompare(b.name));
  if (canonical(select(previous, "durable_object_namespace")) !== canonical(select(candidate, "durable_object_namespace")))
    throw new Error("Automatic publication cannot change Durable Object namespaces or lifecycle");
  const secrets = (version: WorkerVersion) => select(version, "secret_text").map(binding => binding.name);
  if (canonical(secrets(previous)) !== canonical(secrets(candidate))) throw new Error("Automatic publication cannot add or remove secret bindings");
}

function wrangler(args: string[], env: NodeJS.ProcessEnv = {}) {
  // Only the version commands are used: routes, domains, schedules and secrets are never deployed here.
  execFileSync(resolve("node_modules/.bin/wrangler"), args, { stdio: "inherit", env: { ...process.env, ...env }, timeout: 300_000 });
}

export async function checkRuntime(origin: string, config: Pick<WranglerConfig, "vars">, requireLaunchPolicy = true) {
  const headers = { "Cache-Control": "no-cache" };
  // Keep the legacy Robinhood ingress checked. Older rollback versions do not
  // have scoped APIs, so only candidates must also pass both deployment scopes.
  const targets: (8453 | 4663 | null)[] = requireLaunchPolicy ? [null, 4663, 8453] : [null];
  for (const target of targets) {
    const chainId = target ?? 4663, prefix = target ? `/api/chains/${target}` : "/api";
    const readyPath = target ? `${prefix}/readyz` : "/readyz";
    const ready = await (await request(`${origin}${readyPath}`, { headers })).json() as { status: string; chainId: number; writesEnabled: boolean };
    const runtime = await (await request(`${origin}${prefix}/config`, { headers })).json() as { mode: string; chainId: number; deploymentChainId: number; treasury: string | null; writesEnabled: boolean; curvePolicy?: string; launchGuard?: string | null; launchLockAvailable?: boolean; signingPaused?: boolean; controlRevision?: number; securityProtocol?: number; feeEngine?:string|null;feePolicy?:string };
    const treasury = (config.vars[chainId === 8453 ? "BASE_PLATFORM_TREASURY" : "ROBINHOOD_PLATFORM_TREASURY"]
      ?? config.vars.PLATFORM_TREASURY) || null;
    const signingFlag = chainId === 8453 ? config.vars.ENABLE_BASE_TRANSACTIONS
      : config.vars.ENABLE_ROBINHOOD_TRANSACTIONS ?? config.vars.ENABLE_MAINNET_TRANSACTIONS;
    const controlled = config.vars.RUNTIME_SECURITY_PROTOCOL === "1";
    if(controlled && (runtime.securityProtocol!==1 || typeof runtime.signingPaused!=="boolean" || !Number.isSafeInteger(runtime.controlRevision)))
      throw new Error("Runtime safety controls are unavailable or incompatible");
    const writesEnabled = !!treasury && signingFlag === "true" && (!controlled || runtime.signingPaused === false);
    if (ready.status !== "ready" || ready.chainId !== chainId || ready.writesEnabled !== writesEnabled ||
      runtime.mode !== (chainId === 8453 ? "base" : "robinhood") || runtime.chainId !== chainId ||
      runtime.deploymentChainId !== chainId || runtime.writesEnabled !== writesEnabled ||
      runtime.treasury?.toLowerCase() !== treasury?.toLowerCase())
      throw new Error(`Readiness/runtime configuration check failed for ${origin} (${chainId})`);
    assertLaunchRuntime(runtime, config.vars, requireLaunchPolicy, chainId);
    if(controlled) {
      const engine=(chainId===4663 ? config.vars.FEE_ENGINE_ADDRESS : config.vars.BASE_FEE_COLLECTOR_ADDRESS) || null;
      const policy = engine ? chainId === 8453 ? BASE_AUTOMATION_FEE_POLICY : ENGINE_FEE_POLICY : FEE_POLICY;
      // Only paused Base may deliberately withhold an unactivated Collector.
      // Enabled signing always requires the verified candidate to be exposed.
      if(runtime.feePolicy!==policy || runtime.feeEngine && runtime.feeEngine.toLowerCase() !== engine?.toLowerCase() ||
        (chainId !== 8453 || writesEnabled) && (runtime.feeEngine?.toLowerCase() ?? null)!==(engine?.toLowerCase() ?? null))throw new Error("Fee engine runtime differs from the committed release");
    }
  }
}

export async function checkFunctionalSmoke(origin: string, collectorRecovery = true) {
  const results = [];
  for (const chainId of collectorRecovery ? [8453, 4663] as const : [4663] as const) {
  const prefix=`/api/chains/${chainId}`, headers={"Cache-Control":"no-cache"};
  const prices=await (await request(`${origin}${prefix}/first-buy/prices`,{headers})).json() as {assets?:{priceUsd:string|null}[]};
  if(!Array.isArray(prices.assets) || prices.assets.length<2 || prices.assets.some(asset=>asset.priceUsd!==null &&
    (typeof asset.priceUsd!=="string" || !asset.priceUsd || !Number.isFinite(Number(asset.priceUsd)) || Number(asset.priceUsd)<=0)))
    throw new Error("Functional smoke: malformed payment price response");
  const unknownReferences=prices.assets.filter(asset=>asset.priceUsd===null).length;
  if(unknownReferences)console.log(`Functional smoke: auxiliary price references degraded (${unknownReferences}/${prices.assets.length})`);
  const stocks=await (await request(`${origin}${prefix}/stocks`,{headers})).json() as {verified?:boolean;address?:string}[];
  if(!Array.isArray(stocks) || !stocks.length || !stocks.some(stock=>stock.verified===true))throw new Error("Functional smoke: no verified paired assets");
  if (chainId === 8453 && stocks.length !== 36) throw new Error("Functional smoke: Base pairing identity count differs from the admitted 36 assets");
  if (collectorRecovery) {
    const engine = await (await request(`${origin}${prefix}/buyback/engine`, {headers})).json() as {kind?:string;destinationChainId?:number};
    if (chainId === 8453 && (engine.kind !== "base_splits_native" || engine.destinationChainId !== 4663)) throw new Error("Functional smoke: Base fee status is not chain scoped");
    const ledger = await (await request(`${origin}${prefix}/buyback/vault-ledger`, {headers})).json() as {version?:number;initialized?:boolean};
    if (ledger.version !== 1 || typeof ledger.initialized !== "boolean") throw new Error("Functional smoke: malformed shared-vault accounting response");
  }
  const tokens=await (await request(`${origin}${prefix}/tokens?limit=1`,{headers})).json() as any;
  const first=(Array.isArray(tokens)?tokens:tokens.items)?.[0];
  if(first?.address) {
    const quote=await(await request(`${origin}${prefix}/quote`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({address:first.address,side:"buy",amount:"1",slippageBps:100})})).json() as {amountOut?:string};
    if(!quote.amountOut || !/^\d+$/.test(quote.amountOut) || BigInt(quote.amountOut)<=0n)throw new Error("Functional smoke: on-chain quote unavailable");
  } else console.log("Functional smoke: launch trade quote not_run (catalog empty); reference response and asset identity passed");
  results.push({ chainId, auxiliaryPrices: unknownReferences ? "degraded" as const : "available" as const, unknownReferences,
    tradeQuote: first?.address ? "passed" as const : "not_run" as const });
  }
  return results;
}

/** The first paused baseline requires an unused adapter and native account.
 * Later rollbacks must understand native recovery and carry the same reviewed graph. */
export function supportsBaseRecovery(source: string): boolean {
  const marker = source.match(/^export const BASE_RECOVERY_PROTOCOL = (\d+);?\s*$/m);
  const policy = source.match(/^export const BASE_NATIVE_DESTINATION_POLICY = ["']([^"']+)["'];?\s*$/m);
  return !!marker && Number(marker[1]) === BASE_RECOVERY_PROTOCOL && policy?.[1] === BASE_NATIVE_DESTINATION_POLICY;
}
export async function baseRollbackCompatible(input: {
  previousVars: Record<string, string>; candidateVars: Record<string, string>;
  previousManifest?: BaseCollectorManifest; candidateManifest: BaseCollectorManifest;
  previousRecoveryProtocol: boolean; pristine(): Promise<boolean>;
}): Promise<boolean> {
  const { previousVars: previous, candidateVars: candidate, previousManifest: prior, candidateManifest: next } = input;
  if (!candidate.BASE_FEE_COLLECTOR_ADDRESS && next.status === "not_deployed")
    return previous.ENABLE_BASE_TRANSACTIONS !== "true" && candidate.ENABLE_BASE_TRANSACTIONS !== "true" &&
      !next.canaryAuthorization && !next.activation.nativeExecution && next.activation.status === "not_run" &&
      !previous.BASE_FEE_COLLECTOR_ADDRESS && (!prior || prior.status === "not_deployed");
  if (next.status !== "deployed_verified" || next.collector.address?.toLowerCase() !== candidate.BASE_FEE_COLLECTOR_ADDRESS?.toLowerCase()) return false;
  if (input.previousRecoveryProtocol && prior?.status === "deployed_verified" &&
    prior.collector.address?.toLowerCase() === previous.BASE_FEE_COLLECTOR_ADDRESS?.toLowerCase()) {
    try { return baseCollectorGraphFingerprint(prior) === baseCollectorGraphFingerprint(next); }
    catch { return false; }
  }
  if (previous.ENABLE_BASE_TRANSACTIONS === "true" || candidate.ENABLE_BASE_TRANSACTIONS === "true" || previous.BASE_FEE_COLLECTOR_ADDRESS ||
    prior && prior.status !== "not_deployed" || next.activation.status !== "not_run" || next.canaryAuthorization || next.activation.nativeExecution ||
    next.nativeRule.ruleId || next.nativeRule.configurationSha256) return false;
  return input.pristine();
}

export type BasePristineAudit = { version: 3; chainId: 8453; graphFingerprint: string; dependencySha256: string; collectorStart: string;
  automationStart: string; through: string; blockHash: string; activityObserved: boolean };
/** Private CI/operator progress, never a public proof import. Canonical anchors and the current graph are rechecked on every use. */
export function basePristineAuditStore(directory = resolve(".cache/base-pristine-audit")) {
  const path = (fingerprint: string, dependencySha256: string) => {
    if (!/^0x[\da-f]{64}$/i.test(fingerprint)) throw new Error("Invalid pristine graph fingerprint");
    if (!/^[\da-f]{64}$/i.test(dependencySha256)) throw new Error("Invalid pristine dependency hash");
    return join(directory, `${fingerprint.toLowerCase()}-${dependencySha256.toLowerCase()}.json`);
  };
  return {
    load(fingerprint: string, dependencySha256: string): BasePristineAudit | null { try { return JSON.parse(readFileSync(path(fingerprint, dependencySha256), "utf8")); } catch { return null; } },
    save(audit: BasePristineAudit) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const destination = path(audit.graphFingerprint, audit.dependencySha256), temporary = `${destination}.${process.pid}.tmp`;
      const fd = openSync(temporary, "w", 0o600);
      try { writeFileSync(fd, JSON.stringify(audit)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, destination);
      const parent = openSync(directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    },
  };
}
export async function pristineBaseCollector(manifest: BaseCollectorManifest, deps: {
  client?: PublicClient<Transport, any>; verifyGraph?: typeof verifyBaseCollector; now?: () => number;
  maxDurationMs?: number; auditStore?: ReturnType<typeof basePristineAuditStore>; graphAuditStore?: BaseAuditStore;
} = {}): Promise<boolean> {
  const now = deps.now ?? Date.now, duration = deps.maxDurationMs ?? 45_000;
  if (!Number.isFinite(duration) || duration < 0 || duration > 600_000) throw new Error("Invalid pristine audit budget");
  const deadline = now() + duration;
  try {
    const address = manifest.collector.address;
    if (!address) return false;
    const client = deps.client ?? createPublicClient({ chain: base, transport: http(mainnetRpcUrl(8453), { timeout: 20_000, retryCount: 1,
      batch: { batchSize: 20, wait: 0 } }), batch: { multicall: true } });
    const graphStore = deps.graphAuditStore ?? baseOperatorAuditStore();
    let advancedPages = 0;
    const graphAuditStore: BaseAuditStore = {
      getBuybackBatch: id => graphStore.getBuybackBatch(id),
      compareAndSetBuybackAudit: async (next, expected) => {
        const committed = await graphStore.compareAndSetBuybackAudit(next, expected);
        if (committed && typeof next.through === "string" && /^(0|[1-9]\d*)$/.test(next.through) &&
          (typeof expected?.through !== "string" || !/^(0|[1-9]\d*)$/.test(expected.through) || BigInt(next.through) > BigInt(expected.through))) advancedPages++;
        return committed;
      },
    };
    let verified: Awaited<ReturnType<typeof verifyBaseCollector>> | undefined;
    while (now() < deadline) {
      const before = advancedPages;
      try {
        verified = await (deps.verifyGraph ?? verifyBaseCollector)(client, address, { manifest, requireActivation: false, auditStore: graphAuditStore });
        break;
      } catch (error) {
        // Only a completed, persisted prefix may warm the next bounded module page.
        // Changed graph, unavailable RPC, or a scan without durable progress fails closed.
        if (!(error instanceof Error) || error.message !== "Canonical Base audit coverage is incomplete; persisted progress will resume" || advancedPages === before) throw error;
      }
    }
    if (!verified) return false;
    if (!verified.paused) return false;
    const head = await client.getBlock();
    if (!head.hash || head.number === null) return false;
    const abi = parseAbi(["function paused() view returns(bool)"]);
    if (await client.readContract({ address, abi, functionName: "paused", blockNumber: head.number }) !== true ||
      await client.getBalance({ address, blockNumber: head.number }) !== 0n) return false;
    // Native execution authority is separate from the adapter pause. An older
    // build cannot recover native activity, even if the adapter balance is zero.
    const automation = manifest.automationAccount.address;
    const initializedAt = manifest.automationAccount.blockNumber;
    if (!automation || !initializedAt || manifest.nativeRule.ruleId || manifest.nativeRule.configurationSha256) return false;
    const starts = [verified.initialDeploymentBlock, BigInt(initializedAt)];
    if (starts.some(start => start < 0n || start > head.number)) return false;
    const transfer = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
    const receipts = new Map<string, Promise<TransactionReceipt>>();
    const canonicalActivity = async (logs: any[], holder: string, fromBlock: bigint, toBlock: bigint, incoming: boolean) => {
      let observed = false;
      for (const log of logs) {
        if (incoming) {
          // Malformed transfers block this read without becoming sticky cached activity.
          const decoded = decodeEventLog({ abi: [transfer], data: log.data, topics: log.topics, strict: true });
          if (decoded.args.to.toLowerCase() !== holder.toLowerCase()) throw new Error("Pristine transfer recipient differs from its query");
          if (decoded.args.value === 0n || decoded.args.from.toLowerCase() === decoded.args.to.toLowerCase()) continue;
        }
        if (log.removed || !/^0x[\da-f]{64}$/i.test(log.transactionHash) || !/^0x[\da-f]{64}$/i.test(log.blockHash) ||
          typeof log.blockNumber !== "bigint" || log.blockNumber < fromBlock || log.blockNumber > toBlock ||
          !Number.isSafeInteger(log.transactionIndex) || log.transactionIndex < 0 || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 ||
          !/^0x[\da-f]{40}$/i.test(log.address) || !incoming && log.address.toLowerCase() !== holder.toLowerCase() ||
          typeof log.data !== "string" || !/^0x(?:[\da-f]{2})*$/i.test(log.data) || !Array.isArray(log.topics) || log.topics.some((topic: unknown) => typeof topic !== "string" || !/^0x[\da-f]{64}$/i.test(topic)))
          throw new Error("Pristine activity log is malformed or outside its canonical range");
        const key = log.transactionHash.toLowerCase();
        let pending = receipts.get(key);
        if (!pending) { pending = client.getTransactionReceipt({ hash: log.transactionHash }); receipts.set(key, pending); }
        const receipt = await pending;
        if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== key || receipt.blockNumber !== log.blockNumber ||
          receipt.blockHash !== log.blockHash || receipt.transactionIndex !== log.transactionIndex ||
          (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash ||
          !receipt.logs.some(row => row.logIndex === log.logIndex && row.address.toLowerCase() === log.address.toLowerCase() &&
            row.data.toLowerCase() === log.data.toLowerCase() && canonical(row.topics.map(topic => topic.toLowerCase())) === canonical(log.topics.map((topic: string) => topic.toLowerCase()))))
          throw new Error("Pristine activity lacks a canonical successful receipt log");
        observed = true;
      }
      return observed;
    };
    const first = starts[0] < starts[1] ? starts[0] : starts[1];
    if (first === 0n) return false;
    const graphFingerprint = baseCollectorGraphFingerprint(manifest);
    const dependencySha256 = sha256(readFileSync(resolve("package-lock.json")));
    const store = deps.auditStore ?? basePristineAuditStore();
    let audit = store.load(graphFingerprint, dependencySha256);
    const integer = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
    if (audit && (audit.version !== 3 || audit.chainId !== 8453 || audit.graphFingerprint !== graphFingerprint || audit.dependencySha256 !== dependencySha256 ||
      audit.collectorStart !== String(starts[0]) || audit.automationStart !== String(starts[1]) || !integer(audit.through) ||
      BigInt(audit.through) < first - 1n || !/^0x[\da-f]{64}$/i.test(audit.blockHash) || typeof audit.activityObserved !== "boolean")) audit = null;
    // A lagging RPC cannot invalidate a newer retained audit. Wait for a usable provider.
    if (audit && BigInt(audit.through) > head.number) return false;
    if (audit && (await client.getBlock({ blockNumber: BigInt(audit.through) })).hash?.toLowerCase() !== audit.blockHash.toLowerCase()) audit = null;
    if (!audit) {
      const anchor = await client.getBlock({ blockNumber: first - 1n });
      if (!anchor.hash) return false;
      audit = { version: 3, chainId: 8453, graphFingerprint, dependencySha256, collectorStart: String(starts[0]), automationStart: String(starts[1]),
        through: String(first - 1n), blockHash: anchor.hash, activityObserved: false };
    }
    if (audit.activityObserved) return false;
    // Full historical coverage, including arbitrary-token donations. Completed pages survive timeouts/restarts.
    // Each page has at most 18 parallel log reads; every RPC range remains ten blocks.
    for (let page = BigInt(audit.through) + 1n; page <= head.number; page += 60n) {
      if (now() >= deadline) return false;
      const endPage = page + 59n < head.number ? page + 59n : head.number;
      const before = await client.getBlock({ blockNumber: endPage });
      if (!before.hash) return false;
      const reads: Promise<boolean>[] = [];
      for (let range = page; range < page + 60n && range <= head.number; range += 10n) {
        const end = range + 9n < head.number ? range + 9n : head.number;
        if (end >= starts[0]) {
          const fromBlock = range < starts[0] ? starts[0] : range;
          reads.push(client.getLogs({ address, fromBlock, toBlock: end }).then(logs => canonicalActivity(logs, address, fromBlock, end, false)));
          reads.push(client.getLogs({ event: transfer, args: { to: address }, fromBlock, toBlock: end, strict: true }).then(logs => canonicalActivity(logs, address, fromBlock, end, true)));
        }
        if (end >= starts[1]) {
          const fromBlock = range < starts[1] ? starts[1] : range;
          reads.push(client.getLogs({ event: transfer, args: { to: automation }, fromBlock, toBlock: end, strict: true })
            .then(logs => canonicalActivity(logs, automation, fromBlock, end, true)));
        }
      }
      const results = await Promise.all(reads);
      // Persist only a page still attached to its checked predecessor and canonical endpoint.
      if ((await client.getBlock({ blockNumber: BigInt(audit.through) })).hash?.toLowerCase() !== audit.blockHash.toLowerCase() ||
        (await client.getBlock({ blockNumber: endPage })).hash !== before.hash) return false;
      audit = { ...audit, through: String(endPage), blockHash: before.hash, activityObserved: results.some(Boolean) };
      store.save(audit);
      if (audit.activityObserved || now() >= deadline) return false;
    }
    if (await client.getBalance({ address: automation, blockNumber: head.number }) !== 0n) return false;
    const balances = await Promise.all([address, automation].flatMap(holder => [...STOCKS.map(stock => stock.address), BASE_BUYBACK_WETH].map(token =>
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder], blockNumber: head.number! }))));
    return balances.every(value => value === 0n) && (await client.getBlock({ blockNumber: head.number })).hash === head.hash && now() < deadline;
  } catch { return false; }
}

async function main() {
  const build = frozenBuild();
  if (process.argv.slice(2).length && process.argv[2] !== "--check-build") throw new Error("Usage: tsx scripts/release.ts [--check-build]");
  if (process.argv[2] === "--check-build") {
    console.log(`Frozen frontend manifest verified: ${build.identity.commit} (${Object.keys(build.info.files).length} files)`);
    return;
  }
  if (process.versions.node !== "24.11.1") throw new Error("Production publication requires the pinned Node 24.11.1 runtime");
  required("GITHUB_TOKEN"); required("CLOUDFLARE_API_TOKEN");
  const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as WranglerConfig;
  const account = required("CLOUDFLARE_ACCOUNT_ID");
  if (config.name !== workerName || config.account_id !== account || resolve(config.assets.directory) !== build.directory || config.build || config.exports)
    throw new Error("Automatic publication requires the existing Worker, frozen dist assets and no custom build/lifecycle step");
  const currentMaster = async () => (await github<{ object: { sha: string } }>("git/ref/heads/master")).object.sha;
  if (await currentMaster() !== build.identity.commit) {
    console.log("Skipped: master advanced; no candidate was uploaded or activated");
    return;
  }
  const activeVersion = async () => {
    const result = await cloudflare<{ deployments: { versions: { version_id: string; percentage: number }[] }[] }>(account, `scripts/${workerName}/deployments`);
    return requireSingleActiveVersion(result.deployments[0]);
  };
  const previousVersion = await activeVersion();
  const previous = await cloudflare<WorkerVersion>(account, `scripts/${workerName}/versions/${previousVersion}`);
  // Rollback is checked against the previous version's config, not this candidate's vars.
  const previousConfig: WranglerConfig = { ...config, vars: runtimeVarsFromBindings(previous.resources.bindings) };
  const previousCommit=previous.annotations?.["workers/tag"];
  if(!previousCommit || !/^[a-f0-9]{40}$/.test(previousCommit))throw new Error("Previous source commit is required for security configuration comparison");
  const sourceFile=await github<{encoding:string;content:string}>(`contents/wrangler.jsonc?ref=${previousCommit}`);
  if(sourceFile.encoding!=="base64")throw new Error("Cannot inspect previous security configuration");
  const previousSource=JSON.parse(Buffer.from(sourceFile.content,"base64").toString("utf8")) as WranglerConfig;
  let previousRecoveryProtocol = false, previousCollectorManifest: BaseCollectorManifest | undefined;
  for (const path of ["src/lib/base-buyback.ts", "contracts/artifacts/base-collector-deployment.json"]) {
    try {
      const file = await github<{encoding:string;content:string}>(`contents/${path}?ref=${previousCommit}`);
      if (file.encoding !== "base64") continue;
      const bytes = Buffer.from(file.content, "base64").toString("utf8");
      if (path.endsWith(".ts")) previousRecoveryProtocol = supportsBaseRecovery(bytes);
      else previousCollectorManifest = JSON.parse(bytes) as BaseCollectorManifest;
    } catch { /* A pre-Collector baseline has neither file. It must pass the pristine check below. */ }
  }
  const candidateCollectorManifest = baseCollectorDeployment as unknown as BaseCollectorManifest;
  assertSecurityTransition(previousConfig.vars,config.vars,previousSource.vars);
  const compatibleRollback = (duration: number) => rollbackPreservesSafety(previousConfig.vars,config.vars) && baseRollbackCompatible({
    previousVars: previousConfig.vars, candidateVars: config.vars, previousManifest: previousCollectorManifest,
    candidateManifest: candidateCollectorManifest, previousRecoveryProtocol,
    pristine: () => pristineBaseCollector(candidateCollectorManifest, { maxDurationMs: duration }),
  });
  // Establish full anchored coverage outside the short upload/activation checks. Compatible native baselines skip pristine entirely.
  // A failed or interrupted preflight preserves pages for the next trusted CI run, without uploading or activating anything.
  if (!await compatibleRollback(600_000)) throw new ReleaseFailure("blocked_by_safety",
    new Error("Base rollback preflight is incomplete or incompatible; retained pristine progress can resume, production was not changed."));
  const service = await cloudflare<{ default_environment: { script: { migration_tag?: string } } }>(account, `services/${workerName}`);
  const migrationTag = service.default_environment.script.migration_tag;
  if ((config.migrations?.at(-1)?.tag ?? undefined) !== migrationTag)
    throw new Error("Pending Durable Object migration: apply it through a separately authorized migration release before using this workflow");

  const directory = mkdtempSync(join(tmpdir(), "musegod-release-"));
  const buildId = build.identity.buildId!, runUrl = build.identity.runUrl!, releaseUrl = build.identity.releaseUrl!;
  const archivePath = join(directory, "frontend.tar.gz");
  const manifestPath = join(directory, "build-info.json"), recordPath = join(directory, "release.json");
  writeFileSync(manifestPath, readFileSync(join(build.directory, "build-info.json")));
  execFileSync("tar", ["-czf", archivePath, "-C", build.directory, "."]);
  const manifestHash = sha256(readFileSync(manifestPath)), archiveHash = sha256(readFileSync(archivePath));
  let deploymentId: number | undefined;
  const describe = (message: string) => {
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
  };
  const assertFrozen = () => {
    assertReleaseCheckout(build.identity.commit, git("rev-parse", "HEAD"), git("status", "--porcelain", "--untracked-files=all"));
    assertFrozenBuild(build.directory, build.frozen);
    if (sha256(readFileSync(manifestPath)) !== manifestHash || sha256(readFileSync(archivePath)) !== archiveHash)
      throw new Error("Frozen release attachment changed");
  };
  const activate = async (version: string) => {
    wrangler(["versions", "deploy", `${version}@100`, "--durable-objects-code-update-mode", "immediate", "--yes", "--message", `${version === previousVersion ? "Rollback" : "Publish"} ${buildId}`]);
  };
  try {
    const outcome = await publishCandidate({
      commit: build.identity.commit, previousVersion, currentMaster, activeVersion, assertFrozen,
      upload: async () => {
        const output = join(directory, "wrangler-upload.ndjson");
        wrangler(["versions", "upload", "--tag", build.identity.commit, "--message", buildId], { WRANGLER_OUTPUT_FILE_PATH: output });
        const records = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line) as { type: string; worker_name: string; version_id?: string });
        const uploads = records.filter(record => record.type === "version-upload");
        if (uploads.length !== 1 || uploads[0].worker_name !== workerName || !/^[a-f0-9-]{36}$/.test(uploads[0].version_id || ""))
          throw new Error("Wrangler did not report exactly one candidate Worker version");
        const candidate = await readUploadedCandidate(account, uploads[0].version_id!);
        assertCandidateRuntimeBindings(candidate.resources.bindings, config.vars);
        if (candidate.id !== uploads[0].version_id || candidate.annotations?.["workers/tag"] !== build.identity.commit)
          throw new Error("Candidate version metadata does not match the source commit");
        assertPreservedBindings(previous, candidate);
        return candidate.id;
      },
      publishRelease: async (candidate) => {
        const record = {
          schemaVersion: 1, commit: build.identity.commit, buildId, worker: workerName,
          workerVersionId: candidate, previousWorkerVersionId: previousVersion, minimumSecurityProtocol: 1,
          files: { "build-info.json": manifestHash, "frontend.tar.gz": archiveHash },
        };
        writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
        // Create the lightweight tag explicitly; never trust target_commitish when a tag already exists.
        await github("git/refs", { ref: `refs/tags/${buildId}`, sha: build.identity.commit });
        const draft = await github<GitHubRelease>("releases", {
          tag_name: buildId, target_commitish: build.identity.commit, name: buildId, draft: true, make_latest: "false",
          body: `Source: ${REPOSITORY}/commit/${build.identity.commit}\nBuild: ${runUrl}\nCloudflare candidate: ${candidate}\n\nThis is an immutable build record. Production status is recorded in GitHub Deployments after online verification.`,
        });
        const attachments = [manifestPath, archivePath, recordPath];
        for (const path of attachments) {
          const name = path.slice(path.lastIndexOf("/") + 1);
          const uploadUrl = new URL(draft.upload_url.replace(/\{.*$/, ""));
          if (uploadUrl.origin !== "https://uploads.github.com") throw new Error("Unexpected GitHub asset upload origin");
          uploadUrl.searchParams.set("name", name);
          const bytes = readFileSync(path);
          await request(uploadUrl.href, {
            method: "POST", headers: { Authorization: `Bearer ${required("GITHUB_TOKEN")}`, "X-GitHub-Api-Version": apiVersion, "Content-Type": name.endsWith(".gz") ? "application/gzip" : "application/json" }, body: bytes,
          });
        }
        await github(`releases/${draft.id}`, { draft: false, make_latest: "false" }, "PATCH");
        const published = await github<GitHubRelease>(`releases/tags/${buildId}`);
        const tag = await github<{ object: { type: string; sha: string } }>(`git/ref/tags/${buildId}`);
        if (published.draft || published.immutable !== true || published.tag_name !== buildId || published.html_url !== releaseUrl || tag.object.type !== "commit" || tag.object.sha !== build.identity.commit)
          throw new Error("Published Release must be immutable and its tag must lock the full source commit; enable repository Release immutability before publishing");
        if (published.assets.length !== attachments.length) throw new Error("Published Release asset inventory differs from the frozen build");
        for (const path of attachments) {
          const name = path.slice(path.lastIndexOf("/") + 1), hash = sha256(readFileSync(path));
          const asset = published.assets.find(item => item.name === name);
          if (!asset || asset.state !== "uploaded" || asset.digest !== `sha256:${hash}`) throw new Error(`Published Release digest mismatch: ${name}`);
          const url = new URL(asset.browser_download_url);
          if (url.origin !== "https://github.com" || !url.pathname.startsWith(`/${repositorySlug}/releases/download/${buildId}/`)) throw new Error("Unexpected public Release asset URL");
          const publicBytes = new Uint8Array(await (await request(url.href)).arrayBuffer());
          if (sha256(publicBytes) !== hash) throw new Error(`Public Release attachment byte mismatch: ${name}`);
        }
        describe(`Immutable build: ${releaseUrl}; candidate: ${candidate}; rollback point: ${previousVersion}`);
      },
      createDeployment: async (candidate) => {
        const deployment = await github<{ id: number }>("deployments", {
          ref: build.identity.commit, auto_merge: false, required_contexts: [], environment: "production", production_environment: true,
          description: `Publish ${buildId}`, payload: { buildId, releaseUrl, workerVersionId: candidate, previousWorkerVersionId: previousVersion },
        });
        deploymentId = deployment.id;
      },
      status: async (state, description) => {
        if (!deploymentId) throw new Error("GitHub Deployment was not created");
        await github(`deployments/${deploymentId}/statuses`, { state, description, log_url: runUrl, environment_url: origins[0], auto_inactive: state === "success" });
        describe(`Deployment ${deploymentId}: ${state}; ${description}`);
      },
      activate,
      verify: async (candidate) => verifyProductionCandidate(candidate, {
        activeVersion, assertFrozen, describe, wait: waitForPropagation,
        verifyOrigin: async (origin) => {
          execFileSync("npm", ["run", "verify:deployment", "--", "--release", buildId, "--origin", origin], { stdio: "inherit", timeout: 240_000 });
          await checkRuntime(origin, config);
          await checkFunctionalSmoke(origin);
        },
      }),
      rollbackAllowed: async () => compatibleRollback(45_000),
      verifyRollback: async (previous) => verifyProductionCandidate(previous, {
        activeVersion,assertFrozen,describe,wait:waitForPropagation,
        verifyOrigin: async(origin)=>{
          const response=await request(`${origin}/`,{headers:{"Cache-Control":"no-cache"}});
          if(response.headers.get("X-Worker-Version")!==previous)throw new Error(`Rollback activated; edge propagation pending: ${origin}`);
          await checkRuntime(origin,previousConfig);
          await checkFunctionalSmoke(origin, previousRecoveryProtocol);
          describe(`Rollback origin checked: ${origin}; Worker ${previous}`);
        },
      }),
    });
    describe(outcome === "success" ? `Verified production deployment: ${buildId}` : `Skipped ${buildId}: master advanced; candidate was not activated`);
  } catch (error) {
    if (error instanceof ReleaseFailure) describe(`Release failure: rollback=${error.rollback}; previous=${previousVersion}; inspect the Deployment status and run logs`);
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    const describeError = (value: unknown) => {
      let text = value instanceof Error ? value.message : String(value);
      for (const secret of [process.env.GITHUB_TOKEN, process.env.CLOUDFLARE_API_TOKEN]) if (secret) text = text.replaceAll(secret, "[redacted]");
      console.error(text);
    };
    describeError(error);
    if (error instanceof ReleaseFailure) { describeError(error.cause); if (error.rollbackError) describeError(error.rollbackError); }
    process.exitCode = 1;
  }
}
