import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, parseAbi, http, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction,
  type Address, type Hex, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, robinhood } from "viem/chains";
import { BASE_BUYBACK_PROTOCOL, baseCollectorAbi, integer, type BaseCollectorStatus, type BaseFeeBatch, type BaseGasReservation } from "../src/lib/base-buyback";
import { CONTRACTS, sameAddress, type RuntimeConfig } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import type { VaultLedgerReport } from "../src/lib/buyback-vault-ledger";
import { BASE_COLLECTOR_MANIFEST, verifyBaseCollector, assertBaseKeeperAuthority, type BaseCollectorCanaryAuthorization } from "../server/base-collector";
import { baseActivationAcceptanceReady } from "../server/base-activation-record";
import { BASE_GAS_PRICE_ORACLE, baseGasPriceOracleAbi, canonicalBaseReceipt, collectorClaimEvidence, collectorReleaseEvidence, collectorUntrackedSyncEvidence, readCanonicalBaseTransactionFee, readTrustedBaseRecoveryAssets, type BaseRecoveryAssetPolicy } from "../server/base-buyback";
import { loadEnvironment, redact, runtimeFromEnv, mainnetRpcUrl, type Runtime, type RuntimeEnvironment } from "../server/config";
import { SupabaseStore, type StoreBackend } from "../server/supabase-store";
import { LaunchpadService } from "../server/service";
import { assertNativeCustodyReadiness, type NativeCustodyReadiness } from "../server/buyback-vault-runtime";
import { readCanonicalBaseCollectorReleaseHistory } from "../server/base-native-provenance";
import { assertKeeperNonceReady, keeperApiOrigin } from "./buyback-keeper";
import { createBaseKeeperAudit } from "./base-keeper-audit";
import { createLocalReplayClient } from "./base-local-replay";
import { acquireBaseProcessLease, BaseProcessLeaseLostError, type BaseProcessLease } from "./base-process-lease";
import { baseOperatorAuditStore } from "./base-audit-store";

type Client = PublicClient<Transport, any>;
export type BaseKeeperJournal = { version: 2; collector: Address; keeper: Address; batches: BaseFeeBatch[] };
export function baseCanonicalKeeperLease(collector: Address, keeper: Address) {
  return join(homedir(), ".codex", "base-native-keeper", `${collector.toLowerCase()}-${keeper.toLowerCase()}.json`);
}
export function baseCanonicalAuditLease(collector: Address) {
  return join(homedir(), ".codex", "base-native-keeper", `${collector.toLowerCase()}-audit.json`);
}
function assertPublic(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/private|raw|signedTransaction|secret/i.test(key)) throw new Error("Only public Base journal metadata can be persisted");
    assertPublic(item);
  }
}
export async function writeBasePublicJson(path: string, value: unknown) {
  assertPublic(value); await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`; let file;
  try {
    file = await open(temp, "wx", 0o600); await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); await file.close(); file = undefined;
    await rename(temp, path); const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await file?.close(); await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export async function readBasePublicJson<T>(path: string): Promise<T | null> {
  let content: string; try { content = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const value = JSON.parse(content); assertPublic(value); return value as T;
}
export async function allBaseFeeBatches(store: Pick<StoreBackend, "buybackBatchPage">): Promise<BaseFeeBatch[]> {
  const found: BaseFeeBatch[] = []; const cursors = new Set<string>(); let before: { sequence: string } | undefined;
  for (;;) {
    const page = await store.buybackBatchPage(100, before);
    found.push(...page.filter(row => row.protocol === BASE_BUYBACK_PROTOCOL) as unknown as BaseFeeBatch[]);
    if (page.length < 100) break;
    const tail = page.at(-1)!; integer(tail.sequence, true); before = { sequence: tail.sequence };
    const key = JSON.stringify(before); if (cursors.has(key)) throw new Error("Base history pagination did not advance"); cursors.add(key);
  }
  return found;
}
export function isBaseSourceTask(batch: Pick<BaseFeeBatch,"kind">) {
  return ["claim", "release", "sync_untracked", "release_untracked"].includes(batch.kind);
}
export function isBaseUntrackedTask(batch: Pick<BaseFeeBatch,"kind"|"recoveryRegistration">) {
  return batch.kind === "sync_untracked" || batch.kind === "release_untracked" || batch.kind === "claim" && batch.recoveryRegistration === true;
}
export function isBaseAbandonedTask(batch: BaseFeeBatch) {
  try {
    return batch.status === "abandoned" && batch.abandonedBeforeBroadcast === true && !!batch.sourceHash &&
      /^0x[\da-f]{64}$/i.test(batch.sourceHash) && batch.journal?.hash === batch.sourceHash && !!batch.gasReservation &&
      Number.isSafeInteger(batch.journal.nonce) && batch.journal.nonce>=0 && !batch.actualGas && !batch.sourceBlockNumber && !batch.sourceBlockHash && !batch.replacements?.length &&
      sameAddress(batch.journal.to,batch.collector) && batch.journal.dataHash === keccak256(baseFeeTransaction(batch).data);
  } catch { return false; }
}
export function baseTaskIsolated(task: BaseFeeBatch, batches: BaseFeeBatch[], keeper: Address) {
  return batches.some(batch => ["asset_failed","evidence_pending"].includes(batch.status) && batch.journal && sameAddress(batch.journal.caller,keeper) &&
    (batch.kind === "claim" ? !!task.poolId && task.poolId === batch.poolId : task.inputAsset && batch.inputAsset && sameAddress(task.inputAsset.address,batch.inputAsset.address)));
}
export function assertBaseNoUnknown(batches: BaseFeeBatch[], keeper: Address) {
  if (batches.some(batch => batch.protocol === BASE_BUYBACK_PROTOCOL && batch.sourceChainId === 8453 &&
    isBaseSourceTask(batch) && batch.journal && sameAddress(batch.journal.caller, keeper) &&
    (["unknown", "broadcast", "reorg"].includes(batch.status) || batch.status === "abandoned" && !isBaseAbandonedTask(batch)))) throw new Error("This keeper's Base source transactions have unresolved outcomes; new spending is stopped");
}
export async function assertBaseOperationalControl(store: Pick<StoreBackend, "runtimeControl">, runtime: Pick<Runtime, "config">, collector?: Address) {
  const config = runtime.config, control = await store.runtimeControl();
  if (config.mode !== "base" || config.chainId !== 8453 || !config.writesEnabled || config.feePolicy !== BASE_AUTOMATION_FEE_POLICY ||
    !config.feeEngine || collector && !sameAddress(config.feeEngine, collector)) throw new Error("Base signing is paused or its native fee policy differs");
  if (control.paused || !Number.isSafeInteger(control.revision)) throw new Error("Base persistent signing control is paused or unavailable");
  return control.revision;
}
export async function assertBaseVaultCheckpoint(read: () => Promise<VaultLedgerReport>) {
  const report = await read();
  if (!report.initialized || !report.checkpointBlock || !report.indexedThrough || /reorg|rollback|mismatch|failed/i.test(report.reason ?? "")) throw new Error("A canonical Robinhood Vault checkpoint must exist before Base forwarding");
  return report;
}
export function baseReleaseAssetReady(custody: NativeCustodyReadiness, token: Address) {
  const asset = custody.automation.assets.find(row => sameAddress(row.asset, token));
  // A first genuine release introduces a newly launched asset to discovery.
  // An already indexed, quarantined asset cannot bypass its independent replay.
  return !asset || asset.ready;
}
export function assertBaseReleaseReadiness(custody: NativeCustodyReadiness, readiness: {
  available: boolean; nativeAutomationState: string;
}, token: Address) {
  assertNativeCustodyReadiness(custody);
  if (!baseReleaseAssetReady(custody, token)) throw new Error("This fee asset's canonical custody remains quarantined; other verified assets may continue");
  if (!readiness.available || readiness.nativeAutomationState !== "configured") throw new Error("Native Automation authorization and custody checkpoints are not verified");
}
/** The caller has freshly verified the live graph and authorization. Check
 * only the selected release's canonical registration and pending bucket. */
export async function assertBaseSelectedReleaseReadiness(client: Client, task: BaseFeeBatch, custody: NativeCustodyReadiness) {
  assertNativeCustodyReadiness(custody);
  if (!task.release || !["release", "release_untracked"].includes(task.kind) || !sameAddress(task.release.token, task.inputAsset?.address ?? "") ||
    task.release.amount !== task.amountIn || !baseReleaseAssetReady(custody, task.release.token)) throw new BaseFeeAssetUnavailable("This selected release asset is invalid or quarantined");
  const [registered, pending] = await Promise.all([
    client.readContract({ address: task.collector, abi: baseCollectorAbi, functionName: "verifiedAssets", args: [task.release.token] }),
    client.readContract({ address: task.collector, abi: baseCollectorAbi, functionName: task.kind === "release" ? "pendingFees" : "pendingUntracked", args: [task.release.token] }),
  ]);
  if (registered !== true || typeof pending !== "bigint" || pending < integer(task.amountIn)) throw new BaseFeeAssetUnavailable("The selected canonical fee bucket is unavailable or insufficient");
}
export function assertBaseCanaryStorage(runtime: Runtime) {
  if (runtime.config.mode !== "base" || runtime.dataScope !== "verify-base-canary" || runtime.environment?.NODE_ENV === "production" ||
    !runtime.environment?.DATA_DIR || !runtime.supabase?.url || !runtime.supabase.secretKey) throw new Error("Canary execution requires its exact reviewed persistent Supabase scope");
}
export function baseSourceRuntime(runtime: Runtime): Runtime {
  return { ...runtime, dataScope: "base", dataDir: join(runtime.dataDir, "canonical-base") };
}
export function baseSourceStore(runtime: Runtime): StoreBackend {
  if (!runtime.supabase?.url || !runtime.supabase.secretKey) throw new Error("Canonical Base financial history requires persistent Supabase storage");
  return new SupabaseStore(runtime.supabase.url, runtime.supabase.secretKey, "base", "base");
}
export function assertBaseRoleSecrets(environment: RuntimeEnvironment) {
  if (!environment.MUSEGOD_KEEPER_PRIVATE_KEY || Object.entries(environment).some(([name, value]) => value &&
    /PRIVATE_KEY|EVM_DY|MNEMONIC|SEED_PHRASE/i.test(name) && name !== "MUSEGOD_KEEPER_PRIVATE_KEY")) throw new Error("The execute process must contain only its own MUSEGOD_KEEPER_PRIVATE_KEY wallet secret");
}
export function assertBaseKeeperRoles(keeper: Address, manifest: Pick<typeof BASE_COLLECTOR_MANIFEST, "constants"> & Partial<Pick<typeof BASE_COLLECTOR_MANIFEST, "activation">>, treasury?: Address | null) {
  if ([manifest.constants.governor, manifest.constants.operationsTreasury, manifest.constants.automationReceiver, manifest.constants.destinationTreasury, treasury]
    .some(role => role && sameAddress(role, keeper))) throw new Error("The Base gas keeper must be separate from governor, treasury and Automation custody roles");
  if (manifest.activation?.status === "trusted_splits_authorized" && !sameAddress(keeper, manifest.activation.trustedSplitsAcceptance?.keeper ?? ""))
    throw new Error("The Base gas keeper differs from the governor-authorized trusted Splits keeper");
}
export function baseFeeTransaction(batch: BaseFeeBatch) {
  if (batch.protocol !== BASE_BUYBACK_PROTOCOL || batch.sourceChainId !== 8453 || batch.destinationChainId !== 4663) throw new Error("Only native Base fee tasks can be signed");
  if (batch.kind === "claim" && batch.poolId && /^0x[\da-f]{64}$/i.test(batch.poolId)) return { to: batch.collector, value: 0n,
    data: encodeFunctionData({ abi: baseCollectorAbi, functionName: "claimFees", args: [batch.poolId] }) };
  if (batch.kind === "release" && batch.release && sameAddress(batch.release.token, batch.inputAsset?.address ?? "") && batch.release.amount === batch.amountIn)
    return { to: batch.collector, value: 0n, data: encodeFunctionData({ abi: baseCollectorAbi, functionName: "releaseFees", args: [batch.release.token, integer(batch.release.amount)] }) };
  if (batch.kind === "sync_untracked" && batch.inputAsset?.chainId === 8453 && batch.amountIn === "0")
    return { to: batch.collector, value: 0n, data: encodeFunctionData({ abi: baseCollectorAbi, functionName: "syncUntracked", args: [batch.inputAsset.address] }) };
  if (batch.kind === "release_untracked" && batch.inputAsset?.chainId === 8453 && batch.release && sameAddress(batch.release.token,batch.inputAsset.address) && batch.release.amount === batch.amountIn)
    return { to: batch.collector, value: 0n, data: encodeFunctionData({ abi: baseCollectorAbi, functionName: "releaseUntracked", args: [batch.release.token,integer(batch.release.amount)] }) };
  throw new Error("Native Automation performs all swaps and bridges; the local keeper signs only exact claims or releases");
}
export async function submitBaseFeeBatch(batch: BaseFeeBatch, deps: {
  sign(): Promise<Hex>; persistLocal(batch: BaseFeeBatch): Promise<void>; persistPublic(batch: BaseFeeBatch): Promise<void>;
  broadcast(raw: Hex): Promise<Hex>; beforeBroadcast?(batch: BaseFeeBatch): Promise<void>;
}): Promise<BaseFeeBatch> {
  const request = baseFeeTransaction(batch), journal = batch.journal;
  if (batch.sourceHash || batch.actualGas || batch.sourceBlockNumber || batch.sourceBlockHash || batch.replacements?.length)
    throw new Error("A retained source task cannot be signed again; prepare a new task after resolving its outcome");
  if (!journal || !sameAddress(journal.to, request.to) || journal.dataHash !== keccak256(request.data)) throw new Error("The fee journal does not bind the fixed adapter action");
  const raw = await deps.sign(), parsed = parseTransaction(raw);
  if (parsed.type !== "eip1559" || parsed.chainId !== 8453 || !parsed.to || !sameAddress(parsed.to, request.to) || parsed.data !== request.data ||
    (parsed.value ?? 0n) !== 0n || parsed.nonce !== journal.nonce || parsed.gas !== BigInt(journal.gasLimit) || parsed.maxFeePerGas !== BigInt(journal.maxFeePerGas) ||
    parsed.maxPriorityFeePerGas !== 1n || parsed.accessList?.length || !batch.gasReservation ||
    !sameAddress(await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] }), journal.caller)) throw new Error("The signed transaction differs from the fixed Base task");
  let next: BaseFeeBatch = { ...batch, sourceHash: keccak256(raw), status: "unknown", updatedAt: Date.now(), journal: { ...journal, hash: keccak256(raw), signedAt: Date.now() } };
  const persist = async () => { await deps.persistLocal(next); await deps.persistPublic(next); };
  let broadcastStarted = false;
  try {
    await persist(); // The public hash and gas reservation reach durable storage before submission.
    await deps.beforeBroadcast?.(next);
    broadcastStarted = true; // Even a synchronous broadcaster error is an uncertain external outcome.
    const submitted = await deps.broadcast(raw); if (submitted.toLowerCase() !== next.sourceHash!.toLowerCase()) throw new Error("Provider returned another transaction hash");
    next = { ...next, status: "broadcast", updatedAt: Date.now() }; await persist(); return next;
  } catch {
    if (!broadcastStarted) {
      // Only this live process knows raw bytes never left memory. A local intent alone remains unknown after
      // restart; public + local complete markers must agree before the nonce or gas reservation is released.
      const intent: BaseFeeBatch = { ...next,status: "unknown",abandonedBeforeBroadcast: true,updatedAt: Date.now(),error: "Unsubmitted signature abandonment is not durably complete." };
      await deps.persistLocal(intent);
      next = { ...intent,status: "abandoned",updatedAt: Date.now(),error: "Local signature abandoned before broadcast; no source spending occurred." };
      await deps.persistPublic(next);
      await deps.persistLocal(next);
      return next;
    }
    next = { ...next, status: "unknown", updatedAt: Date.now(), error: "Submission outcome unresolved; inspect the retained hash before any new source spending." };
    await persist(); throw new Error(next.error);
  }
}
const claimOutcomeAbi = parseAbi([
  "event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)",
  "event ClaimFailed(bytes32 indexed poolId,address indexed manager,bytes reason)",
]);
function claimReceiptOutcome(receipt: Awaited<ReturnType<typeof canonicalBaseReceipt>>, batch: BaseFeeBatch) {
  const managers = [CONTRACTS.initializer, CONTRACTS.rehype];
  const income = [], failed = new Set<string>();
  for (const log of receipt.logs.filter(log => sameAddress(log.address, batch.collector))) {
    const event = decodeEventLog({ abi: claimOutcomeAbi, topics: log.topics, data: log.data, strict: true });
    if (event.args.poolId !== batch.poolId || !managers.some(manager => sameAddress(manager, event.args.manager))) throw new Error("Unsupported claim manager or pool log");
    if (event.eventName === "FeesClaimed") income.push(event.args);
    else { if (failed.has(event.args.manager.toLowerCase())) throw new Error("Duplicate failed manager log"); failed.add(event.args.manager.toLowerCase()); }
  }
  if (!income.length) throw new Error("Canonical claim receipt lacks required manager delta logs");
  if (income.some(row => row.amount > 0n)) return { credits: collectorClaimEvidence(receipt, batch.collector, batch.poolId!),needsRuntime: false };
  // _credit always emits both actual deltas, including zero. A raced claim is
  // resolved only with the exact runtime and complete, recognized manager pairs.
  let pair: string[] | undefined;
  for (const manager of managers) {
    const rows = income.filter(row => sameAddress(row.manager, manager));
    if (!rows.length) { if (!failed.has(manager.toLowerCase())) throw new Error("Missing manager outcome"); continue; }
    const tokens = rows.map(row => row.token.toLowerCase());
    if (rows.length !== 2 || failed.has(manager.toLowerCase()) || tokens[0] >= tokens[1] || BigInt(tokens[0]) === 0n ||
      pair && (pair[0] !== tokens[0] || pair[1] !== tokens[1])) throw new Error("Incomplete or mismatched zero manager pair");
    pair = tokens;
  }
  for (const log of receipt.logs) {
    try { const event = decodeEventLog({ abi: erc20Abi, topics: log.topics, data: log.data, strict: true });
      if (event.eventName === "Transfer" && event.args.value > 0n && (sameAddress(event.args.from, batch.collector) || sameAddress(event.args.to, batch.collector))) throw new Error("Zero claim has an actual asset delta");
    } catch (error) { if (error instanceof Error && error.message === "Zero claim has an actual asset delta") throw error; }
  }
  return { credits: [],needsRuntime: true };
}
export const BASE_EVIDENCE_RETRY_MS = 30_000;
export const BASE_ASSET_RETRY_MS = 300_000;
class BaseClaimRuntimeUnavailable extends Error {}
export async function reconcileBaseFeeBatch(batch: BaseFeeBatch, client: Client, replacement?: Hex,
  expectedRuntimeHash = BASE_COLLECTOR_MANIFEST.collector.runtimeHash): Promise<BaseFeeBatch> {
  if (batch.status === "abandoned") return isBaseAbandonedTask(batch) ? batch : { ...batch,status: "unknown",error: "Abandoned source marker is incomplete; signing remains stopped." };
  if (!batch.sourceHash || !batch.journal) return batch;
  const hash = replacement ?? batch.sourceHash;
  try {
    const receipt = await canonicalBaseReceipt(client, hash, 8453), tx = await client.getTransaction({ hash });
    if (tx.hash !== hash || receipt.transactionHash !== hash || !sameAddress(tx.from, batch.journal.caller) || tx.nonce !== batch.journal.nonce || tx.value !== 0n) throw new Error("Canonical transaction identity changed");
    const retainedCancellation = batch.replacements?.some(row => row.cancelled && row.hash.toLowerCase() === hash.toLowerCase());
    const cancellation = (!!replacement || retainedCancellation) && tx.to && sameAddress(tx.to, tx.from) && tx.input === "0x";
    if (retainedCancellation && !cancellation) throw new Error("Retained cancellation no longer matches its canonical identity");
    if (cancellation) {
      if (receipt.status !== "success" || receipt.logs.length || !["legacy", "eip1559", "eip2930"].includes(tx.type) || (tx as any).authorizationList?.length ||
        [await client.getCode({ address: tx.from, blockNumber: receipt.blockNumber }), await client.getCode({ address: tx.from, blockNumber: receipt.blockNumber - 1n })].some(code => !!code && code !== "0x")) throw new Error("Delegation or execution cannot prove an empty cancellation");
    } else {
      const request = baseFeeTransaction(batch);
      if (!tx.to || !sameAddress(tx.to, request.to) || tx.input !== request.data || keccak256(tx.input) !== batch.journal.dataHash) throw new Error("Replacement changed the fixed action");
    }
    const retained = hash === batch.sourceHash && ["claimed","synced","released","reverted","cancelled","asset_failed","evidence_pending"].includes(batch.status) ? batch.actualGas : undefined;
    const actualGas = await readCanonicalBaseTransactionFee(client, receipt,retained);
    const next: BaseFeeBatch = { ...batch, sourceHash: hash, sourceBlockNumber: String(receipt.blockNumber), sourceBlockHash: receipt.blockHash,
      actualGas, updatedAt: Date.now(), error: undefined,evidenceRetryAt: undefined,sourceFinalized: undefined,
      status: cancellation ? "cancelled" : receipt.status === "reverted" ? "reverted" : batch.kind === "claim" ? "claimed" : batch.kind === "sync_untracked" ? "synced" : "released" };
    if (!cancellation && receipt.status === "success") try {
      if (batch.kind === "claim") {
        const outcome = claimReceiptOutcome(receipt,batch);
        if (outcome.needsRuntime) {
          // The reviewed Collector is immutable. Its fresh code proves the same fixed event behavior without
          // requiring archive state. RPC/runtime identity failures are retryable evidence, never asset faults.
          let code: Hex | undefined;
          try { code = await client.getCode({ address: batch.collector,blockTag: "latest" }); }
          catch { throw new BaseClaimRuntimeUnavailable("Zero-credit runtime RPC is unavailable"); }
          if (!expectedRuntimeHash || typeof code !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(code) || keccak256(code) !== expectedRuntimeHash) throw new BaseClaimRuntimeUnavailable("Zero-credit runtime identity is not verified");
        }
        next.claimCredits = outcome.credits; next.claimHashes = [hash];
        next.claimAssets = [...new Set(receipt.logs.filter(log => sameAddress(log.address,batch.collector)).flatMap(log => {
          try { const event = decodeEventLog({ abi: claimOutcomeAbi, topics: log.topics,data: log.data,strict: true });
            return event.eventName === "FeesClaimed" && event.args.poolId === batch.poolId && [CONTRACTS.initializer,CONTRACTS.rehype].some(manager=>sameAddress(manager,event.args.manager)) ? [event.args.token] : [];
          } catch { return []; }
        }))];
      } else if (batch.kind === "sync_untracked") next.untrackedSync = collectorUntrackedSyncEvidence(receipt,batch.collector,batch.inputAsset!.address);
      else next.release = collectorReleaseEvidence(receipt, batch.collector, batch.release!.token, batch.release!.amount, batch.release!.automation,batch.kind === "release_untracked");
    } catch (error) {
      // Exact signed transaction + canonical mined receipt + complete actual gas proves this nonce was consumed.
      // A token/event/provenance fault cannot turn that known transaction outcome into a global nonce freeze.
      next.status = error instanceof BaseClaimRuntimeUnavailable ? "evidence_pending" : "asset_failed";
      next.evidenceRetryAt = Date.now() + (next.status === "evidence_pending" ? BASE_EVIDENCE_RETRY_MS : BASE_ASSET_RETRY_MS);
      next.error = next.status === "evidence_pending" ? "Canonical transaction mined; its runtime evidence is pending a bounded retry." : "Canonical transaction mined, but its receipt has inconsistent asset evidence; the pool or asset is withheld until a bounded recheck.";
      delete next.claimCredits; delete next.claimAssets; delete next.untrackedSync;
    }
    if (replacement) next.replacements = [...(batch.replacements ?? []).filter(row => row.hash !== hash), { hash, cancelled: !!cancellation, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash }];
    return next;
  } catch { return { ...batch, sourceFinalized: undefined,status: batch.sourceBlockHash ? "reorg" : "unknown", error: "Source transaction or fee evidence remains unresolved.", updatedAt: Date.now() }; }
}
/** Full history remains durable; RPC revalidation is bounded and never rewrites finalized terminal outcomes on a transient read error. */
export async function reconcileBaseKeeperHistory(journal: BaseKeeperJournal,history: BaseFeeBatch[],client: Client,expectedRuntimeHash: Hex | null,
  replacementHint?: readonly [string,Hex],limit = 64,now = Date.now()) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("Invalid bounded source reconciliation limit");
  const own = history.filter(batch=>isBaseSourceTask(batch)&&!isBaseAbandonedTask(batch)&&batch.journal&&sameAddress(batch.journal.caller,journal.keeper)&&batch.sourceHash);
  if (!own.length) return [];
  const terminal = (batch: BaseFeeBatch) => ["claimed","synced","released","reverted","cancelled"].includes(batch.status);
  const retryEvidence = (batch: BaseFeeBatch) => ["asset_failed","evidence_pending"].includes(batch.status);
  const knownMined = (batch: BaseFeeBatch) => terminal(batch)||retryEvidence(batch);
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.number === null || !finalized.hash) throw new Error("Canonical finalized source head is unavailable; retained outcomes were not changed");
  const lastAnchor = own.filter(batch=>knownMined(batch)&&batch.sourceFinalized&&batch.sourceBlockNumber&&batch.sourceBlockHash)
    .sort((a,b)=>BigInt(a.sourceBlockNumber!) < BigInt(b.sourceBlockNumber!) ? 1 : -1)[0];
  if (lastAnchor && (finalized.number < BigInt(lastAnchor.sourceBlockNumber!) || (await client.getBlock({ blockNumber: BigInt(lastAnchor.sourceBlockNumber!) })).hash !== lastAnchor.sourceBlockHash))
    throw new Error("Finalized source anchor is unavailable or changed; retained outcomes require audited recovery");
  const candidates = own.filter(batch=>batch.id===replacementHint?.[0] || (retryEvidence(batch) ? !batch.evidenceRetryAt || now>=batch.evidenceRetryAt : !terminal(batch)||!batch.sourceFinalized))
    .sort((a,b)=>Number(knownMined(a))-Number(knownMined(b)) || (knownMined(a)&&knownMined(b) ? (a.evidenceRetryAt??0)-(b.evidenceRetryAt??0) : 0) || a.journal!.nonce-b.journal!.nonce || a.createdAt-b.createdAt);
  if (replacementHint) candidates.sort((a,b)=>Number(b.id===replacementHint[0])-Number(a.id===replacementHint[0]));
  const results: BaseFeeBatch[] = [];
  for (const batch of candidates.slice(0,limit)) {
    if (terminal(batch)&&batch.actualGas&&batch.sourceBlockNumber&&batch.sourceBlockHash&&batch.actualGas.transactionHash===batch.sourceHash&&
      batch.actualGas.blockNumber===batch.sourceBlockNumber&&batch.actualGas.blockHash===batch.sourceBlockHash&&batch.id!==replacementHint?.[0]) {
      // Same canonical header commits the previously verified receipt. A transient receipt/code outage cannot undo it.
      const canonical = await client.getBlock({ blockNumber: BigInt(batch.sourceBlockNumber) });
      if (canonical.hash === batch.sourceBlockHash) {
        if (BigInt(batch.sourceBlockNumber)<=finalized.number&&!batch.sourceFinalized) results.push({ ...batch,sourceFinalized: true });
        continue;
      }
    }
    const replacement = batch.id===replacementHint?.[0]?replacementHint[1]:undefined;
    let retainedCanonical = false;
    if (retryEvidence(batch)&&batch.sourceBlockNumber&&batch.sourceBlockHash&&batch.actualGas&&batch.actualGas.transactionHash===batch.sourceHash&&
      batch.actualGas.blockNumber===batch.sourceBlockNumber&&batch.actualGas.blockHash===batch.sourceBlockHash)
      retainedCanonical = (await client.getBlock({ blockNumber: BigInt(batch.sourceBlockNumber) })).hash===batch.sourceBlockHash;
    let result = await reconcileBaseFeeBatch(batch,client,replacement,expectedRuntimeHash);
    // A same canonical header commits the already-verified consumed nonce and actual gas. A temporary receipt
    // outage while rechecking evidence cannot erase that fact; genuine source reorgs still become global blockers.
    if (!replacement&&retainedCanonical&&["unknown","reorg"].includes(result.status)&&
      (await client.getBlock({ blockNumber: BigInt(batch.sourceBlockNumber!) })).hash===batch.sourceBlockHash)
      result = { ...batch,status: "evidence_pending",evidenceRetryAt: now+BASE_EVIDENCE_RETRY_MS,updatedAt: now,error: "Retained mined source is canonical; asset evidence RPC remains pending." };
    if (knownMined(result)&&result.sourceBlockNumber&&result.sourceBlockHash&&result.actualGas&&BigInt(result.sourceBlockNumber)<=finalized.number) result.sourceFinalized=true;
    results.push(result);
  }
  if ((await client.getBlock({ blockNumber: finalized.number })).hash !== finalized.hash) throw new Error("Finalized source head changed before result persistence");
  return results;
}
export async function reserveBaseGas(client: Client, transaction: { to: Address; data: Hex; value: bigint }, nonce: number, gasLimit: bigint, maxFeePerGas: bigint): Promise<BaseGasReservation> {
  if (await client.getChainId() !== 8453 || gasLimit <= 0n || maxFeePerGas <= 0n || transaction.value !== 0n) throw new Error("Valid Base gas evidence is required");
  const block = await client.getBlock({ blockTag: "latest" }); if (block.number === null || !block.hash) throw new Error("Canonical Base gas block unavailable");
  const unsigned = serializeTransaction({ ...transaction, chainId: 8453, nonce, gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: 1n, type: "eip1559" });
  const unsignedBytes = (unsigned.length - 2) / 2;
  const read = (functionName: "getL1Fee" | "getL1FeeUpperBound" | "getOperatorFee", args: readonly unknown[]) => client.readContract({ address: BASE_GAS_PRICE_ORACLE,
    abi: baseGasPriceOracleAbi, functionName, args: args as any, blockNumber: block.number! });
  const [exact, upper, operator] = await Promise.all([read("getL1Fee", [unsigned]), read("getL1FeeUpperBound", [BigInt(unsignedBytes + 65)]), read("getOperatorFee", [gasLimit])]);
  if ([exact, upper, operator].some(value => typeof value !== "bigint" || value < 0n) || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("Base fee estimate is unavailable or reorganized");
  const execution = gasLimit * maxFeePerGas, l1 = 2n * (exact > upper ? exact : upper), operatorFee = operator * 2n;
  return { executionWei: String(execution), l1Wei: String(l1), operatorWei: String(operatorFee), totalWei: String(execution + l1 + operatorFee),
    blockNumber: String(block.number), blockHash: block.hash, unsignedHash: keccak256(unsigned), unsignedBytes };
}
export async function assertBaseGasReservationCurrent(client: Client, transaction: { to: Address; data: Hex; value: bigint }, nonce: number,
  gasLimit: bigint, maxFeePerGas: bigint, reservation: BaseGasReservation) {
  const fresh = await reserveBaseGas(client, transaction, nonce, gasLimit, maxFeePerGas);
  if (fresh.unsignedHash !== reservation.unsignedHash || BigInt(fresh.totalWei) > BigInt(reservation.totalWei)) throw new Error("Base gas increased beyond its reservation; rebuild before signing");
}
function unionBatches(local: BaseFeeBatch[], canonical: BaseFeeBatch[], requireAbandonedPair = false) {
  const savedCanonical = new Map(canonical.map(batch => [batch.id, batch])),savedLocal = new Map(local.map(batch=>[batch.id,batch])),merged = new Map(savedCanonical);
  for (const batch of local) { const other = merged.get(batch.id); if (!other || batch.updatedAt > other.updatedAt) merged.set(batch.id, batch); }
  if (requireAbandonedPair) for (const batch of [...merged.values()]) if (batch.status === "abandoned") {
    const own = savedLocal.get(batch.id),publicRow = savedCanonical.get(batch.id);
    if (!own || !publicRow || !isBaseAbandonedTask(own) || !isBaseAbandonedTask(publicRow) ||
      own.sourceHash !== publicRow.sourceHash || own.journal!.nonce !== publicRow.journal!.nonce ||
      !sameAddress(own.journal!.caller,publicRow.journal!.caller) || own.journal!.dataHash !== publicRow.journal!.dataHash)
      merged.set(batch.id,{ ...batch,status: "unknown",error: "Abandonment is not durably complete in both native source journals." });
  }
  return [...merged.values()];
}
export function baseCanonicalGasSpent(all: BaseFeeBatch[], keeper: Address, untracked = false) {
  let gas = 0n; const nonces = new Map<string,bigint>();
  for (const batch of all) if (isBaseSourceTask(batch) && isBaseUntrackedTask(batch) === untracked && batch.journal && sameAddress(batch.journal.caller, keeper)) {
    if (batch.status === "abandoned") { if (!isBaseAbandonedTask(batch)) throw new Error("Abandoned gas reservation is not durably proven unused");continue; }
    const key = `${batch.journal.caller.toLowerCase()}:${batch.journal.nonce}`;
    const fee = batch.actualGas?.totalWei ?? batch.gasReservation?.totalWei;
    if (!fee) throw new Error("Prior source task has no complete gas reservation");
    let charge = integer(fee, true);
    if (["unknown", "broadcast", "reorg"].includes(batch.status)) {
      if (!batch.gasReservation) throw new Error("Unresolved source task has no complete gas reservation");
      const reserved = integer(batch.gasReservation.totalWei, true); if (reserved > charge) charge = reserved;
    }
    if (charge > (nonces.get(key) ?? -1n)) nonces.set(key, charge);
  }
  gas = [...nonces.values()].reduce((sum, charge) => sum + charge, 0n);
  return gas;
}
export async function assertCanonicalBaseUntrackedBudget(journal: BaseKeeperJournal,next: BaseFeeBatch,store: Pick<StoreBackend,"buybackBatchPage">,maxGas: bigint) {
  if (!isBaseUntrackedTask(next) || !next.gasReservation) throw new Error("An unknown recovery gas reservation is required");
  const all = unionBatches(journal.batches,await allBaseFeeBatches(store),true).filter(batch=>batch.id !== next.id);
  if (baseCanonicalGasSpent(all,journal.keeper,true) + integer(next.gasReservation.totalWei,true) > maxGas) return false;
  return true;
}
export function baseUntrackedWalletHasReserve(balance: bigint,reservation: string,genuineCap: bigint,history: BaseFeeBatch[],keeper: Address) {
  const spent = baseCanonicalGasSpent(history,keeper),remaining = genuineCap > spent ? genuineCap - spent : 0n;
  return balance >= integer(reservation,true) + remaining;
}
class BaseUntrackedBudgetExhausted extends Error {}
class BaseFeeAssetUnavailable extends Error {}
/** No signature/hash exists at this point. Simulation/asset errors may skip one task; unresolved wallet nonces still stop everything. */
export async function prepareBaseFeeTask(task: BaseFeeBatch,client: Client,keeper: Address,now=Date.now()): Promise<BaseFeeBatch|null> {
  const transaction = baseFeeTransaction(task);
  const [latest,pending] = await Promise.all([client.getTransactionCount({ address: keeper,blockTag: "latest" }),client.getTransactionCount({ address: keeper,blockTag: "pending" })]);
  assertKeeperNonceReady(latest,pending);
  try {
    await client.call({ ...transaction,account: keeper });
    const estimate = await client.estimateGas({ ...transaction,account: keeper }), gas = (estimate * 125n + 99n) / 100n;
    const fees = await client.estimateFeesPerGas(); if (!fees.maxFeePerGas) return null;
    const reservation = await reserveBaseGas(client,transaction,latest,gas,fees.maxFeePerGas);
    return { ...task,gasReservation: reservation,journal: { caller: keeper,nonce: latest,to: task.collector,dataHash: keccak256(transaction.data),hash: `0x${"00".repeat(32)}`,gasLimit: String(gas),maxFeePerGas: String(fees.maxFeePerGas),signedAt: now } };
  } catch { return null; }
}
export async function assertCanonicalBaseCanaryBudget(journal: BaseKeeperJournal, next: BaseFeeBatch, store: Pick<StoreBackend, "buybackBatchPage"> & Partial<Pick<StoreBackend,"getBuybackBatch"|"compareAndSetBuybackAudit">>,
  client: Client, maxGas: bigint, authorization?: BaseCollectorCanaryAuthorization, initialDeploymentBlock?: bigint) {
  const all = unionBatches(journal.batches, await allBaseFeeBatches(store),true).filter(batch => batch.id !== next.id);
  if (isBaseUntrackedTask(next)) throw new Error("The genuine-fee/private canary budget does not permit unknown recovery");
  const gas = baseCanonicalGasSpent(all,journal.keeper);
  if (!next.gasReservation || gas + integer(next.gasReservation.totalWei, true) > maxGas) throw new Error("The cumulative canonical Base gas budget is exhausted");
  if (authorization) {
    if (!sameAddress(authorization.keeper, journal.keeper)) throw new Error("The owner authorized a different canary keeper");
    if (next.kind === "release") {
      const budget = authorization.releaseBudgets.find(row => sameAddress(row.token, next.release!.token));
      if (!budget || budget.decimals !== next.inputAsset?.decimals) throw new Error("The owner did not authorize this canary release asset precision");
      if (initialDeploymentBlock === undefined) throw new Error("The verified Collector deployment block is required for a cumulative canary release ceiling");
      const head = await client.getBlock({ blockTag: "latest" });
      if (head.number === null || !head.hash) throw new Error("Canonical canary release budget head is unavailable");
      const audit = store as Partial<Pick<StoreBackend,"getBuybackBatch"|"compareAndSetBuybackAudit">>;
      const history = await readCanonicalBaseCollectorReleaseHistory(client, next.collector, next.release!.automation, initialDeploymentBlock, head.number,
        audit.getBuybackBatch && audit.compareAndSetBuybackAudit ? audit as Pick<StoreBackend,"getBuybackBatch"|"compareAndSetBuybackAudit"> : undefined);
      const owned = history.filter(row => sameAddress(row.from, journal.keeper) && sameAddress(row.token, budget.token));
      const released = owned.reduce((sum, row) => sum + row.amount, 0n);
      const receivedHashes = new Set(owned.map(row => row.transactionHash.toLowerCase()));
      const reserved = all.filter(batch => batch.kind === "release" && batch.journal && sameAddress(batch.journal.caller, journal.keeper) &&
        batch.release && sameAddress(batch.release.token, budget.token) && ["unknown", "broadcast", "reorg"].includes(batch.status) &&
        (!batch.sourceHash || !receivedHashes.has(batch.sourceHash.toLowerCase())))
        .reduce((sum, batch) => sum + integer(batch.amountIn), 0n);
      const pending = await client.readContract({ address: next.collector, abi: baseCollectorAbi, functionName: "pendingFees", args: [budget.token], blockNumber: head.number });
      if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error("Canary release budget changed during canonical verification");
      if (released + reserved + integer(next.amountIn) > integer(budget.maxAmount) || integer(next.amountIn) > pending) throw new Error("The cumulative canary token release ceiling or genuine fee income is exceeded");
    }
  }
}
/** Independent unknown recovery is automatic only outside the existing genuine-fee-only private authorization. */
export const BASE_UNTRACKED_COOLDOWN_MS = 3_600_000;
type UntrackedRecoveryContext = { policies: readonly BaseRecoveryAssetPolicy[]; history: BaseFeeBatch[]; keeper: Address; now: number };
export function baseUntrackedAssetCooling(asset: Address,kind: "sync_untracked"|"release_untracked"|"claim",context: UntrackedRecoveryContext) {
  return context.history.some(batch=>isBaseUntrackedTask(batch)&&batch.journal&&sameAddress(batch.journal.caller,context.keeper)&&batch.inputAsset&&sameAddress(batch.inputAsset.address,asset)&&
    !isBaseAbandonedTask(batch)&&
    ((batch.kind === kind)||(kind === "sync_untracked" && batch.kind === "release_untracked"))&&context.now < batch.createdAt + BASE_UNTRACKED_COOLDOWN_MS);
}
export function baseUntrackedRecoveryTasks(status: BaseCollectorStatus, seed: (kind: "sync_untracked" | "release_untracked") => BaseFeeBatch,
  custody: NativeCustodyReadiness, canary = false,context?: UntrackedRecoveryContext): BaseFeeBatch[] {
  if (!context || canary || !status.available || status.paused || !status.automation) return [];
  const tasks: BaseFeeBatch[] = [];
  for (const asset of status.assets) {
    const policy = context.policies.find(policy=>sameAddress(policy.address,asset.address));
    if (!policy || policy.decimals !== asset.decimals || !asset.verifiedAsset) continue;
    if (integer(asset.pendingUntracked ?? "0",true) >= integer(policy.minimumRaw) && baseReleaseAssetReady(custody,asset.address) && !baseUntrackedAssetCooling(asset.address,"release_untracked",context))
      tasks.push({ ...seed("release_untracked"),inputAsset: policy,amountIn: asset.pendingUntracked!,release: { token: asset.address,amount: asset.pendingUntracked!,automation: status.automation } });
    else if (integer(asset.untracked,true) >= integer(policy.minimumRaw) && !baseUntrackedAssetCooling(asset.address,"sync_untracked",context)) tasks.push({ ...seed("sync_untracked"),inputAsset: policy,amountIn: "0" });
  }
  return tasks.filter(task=>!baseTaskIsolated(task,context.history,context.keeper));
}
export async function runBaseBuybackKeeper(args = process.argv.slice(2)) {
  const execute = args.includes("--execute"), auditOnly = args.includes("--audit-only");
  if (execute && auditOnly) throw new Error("Host audit-only mode cannot sign or broadcast");
  if (args.some(arg => !["--execute", "--audit-only", "--once", "--help"].includes(arg) && !/^--(?:api|interval|max-gas-wei|max-untracked-gas-wei|replacement)=/.test(arg))) throw new Error("Unsupported Base keeper option");
  for (const name of ["api", "interval", "max-gas-wei", "max-untracked-gas-wei", "replacement"]) if (args.filter(arg => arg.startsWith(`--${name}=`)).length > 1) throw new Error(`Select only one --${name} value`);
  if (args.includes("--help")) { console.log("Base native fee keeper: [--once] [--interval=30000]. --audit-only maintains canonical journals and publishes bounded display snapshots without a signing key. All audit/readiness checks use explicit Base and Robinhood RPCs on this host; call traces use reviewed local replay, with unsupported execution remaining pending. Public Worker APIs never authorize spending. --api is retained only as the private canary's signed origin. --execute requires --max-gas-wei for genuine fees, an isolated key process, canonical journals and reviewed controls. Optional --max-untracked-gas-wei enables a separate cumulative unknown-recovery gas ceiling; omission disables recovery. Unknown exhaustion never consumes genuine-fee gas. Private canary never permits unknown recovery. No swap or bridge signing. --replacement=<batchId>:<hash> revalidates one retained same-nonce task."); return; }
  if (!BASE_COLLECTOR_MANIFEST.collector.address || BASE_COLLECTOR_MANIFEST.status !== "deployed_verified") {
    if (execute) throw new Error("Base native fee adapter is not deployed; no transaction was signed");
    console.log(JSON.stringify({ mode: "dry_run", state: "not_deployed", chainId: 8453 })); return;
  }
  if (!execute) loadEnvironment(); else assertBaseRoleSecrets(process.env);
  const origin = keeperApiOrigin(args.find(arg => arg.startsWith("--api="))?.slice(6) ?? "https://musegod.fun");
  const interval = Number(args.find(arg => arg.startsWith("--interval="))?.slice(11) ?? 30000);
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 60000) throw new Error("Invalid keeper interval");
  const rawCap = args.find(arg => arg.startsWith("--max-gas-wei="))?.slice(14);
  if (execute && (!rawCap || !/^[1-9]\d{0,77}$/.test(rawCap))) throw new Error("An explicit cumulative --max-gas-wei ceiling is required");
  const rawUntrackedCap = args.find(arg=>arg.startsWith("--max-untracked-gas-wei="))?.slice("--max-untracked-gas-wei=".length);
  const untrackedCap = rawUntrackedCap === undefined ? 0n : integer(rawUntrackedCap);
  const hint = args.find(arg => arg.startsWith("--replacement="))?.slice(14);
  const replacementHint = hint?.match(/^([^:]{1,200}):(0x[\da-f]{64})$/i);
  if (hint && (!execute || !replacementHint)) throw new Error("A replacement hint requires --execute and the exact batchId:transactionHash");
  const runtime = runtimeFromEnv(undefined, { ...process.env, CHAIN_MODE: "base" });
  const canary = runtime.dataScope === "verify-base-canary"; if (canary) assertBaseCanaryStorage(runtime);
  (runtime as Runtime & {canaryOrigin?: string}).canaryOrigin = canary ? origin : undefined;
  const source = baseSourceStore(runtime), service = new LaunchpadService(runtime), collector = BASE_COLLECTOR_MANIFEST.collector.address;
  const client = createLocalReplayClient(createPublicClient({ chain: base, transport: http(runtime.rpcUrl, { batch: { batchSize: 20, wait: 0 }, timeout: 30000, retryCount: 0 }), batch: { multicall: true } }), { chainId: 8453, rpcUrl: runtime.rpcUrl, auditStore: baseOperatorAuditStore() });
  const destinationRpc = mainnetRpcUrl(4663, runtime.environment);
  const destination = createPublicClient({ chain: robinhood, transport: http(destinationRpc, { batch: { batchSize: 20, wait: 0 }, timeout: 30000, retryCount: 0 }), batch: { multicall: true } });
  const audit = createBaseKeeperAudit({ runtime, service, source, sourceClient: client, destinationClient: destination });
  const account = execute ? privateKeyToAccount(process.env.MUSEGOD_KEEPER_PRIVATE_KEY as Hex) : null;
  if (account) assertBaseKeeperRoles(account.address, BASE_COLLECTOR_MANIFEST);
  const path = account ? baseCanonicalKeeperLease(collector, account.address) : null;
  let unlock: BaseProcessLease | null = null, unlockAudit: BaseProcessLease | null = null;
  let journal: BaseKeeperJournal = { version: 2, collector, keeper: account?.address ?? "0x0000000000000000000000000000000000000001", batches: [] };
  let stopping = false; process.once("SIGINT", () => { stopping = true; }); process.once("SIGTERM", () => { stopping = true; });
  try {
    unlockAudit = await acquireBaseProcessLease(baseCanonicalAuditLease(collector));
    unlock = path ? await acquireBaseProcessLease(path) : null;
    if (path) journal = await readBasePublicJson<BaseKeeperJournal>(path) ?? journal;
    if (journal.version !== 2 || !sameAddress(journal.collector, collector) || !sameAddress(journal.keeper, account?.address ?? journal.keeper) || !Array.isArray(journal.batches)) throw new Error("The canonical native keeper journal identity differs");
    do {
      const observedAt = Date.now();
      let projectionPublished = false;
      try {
      unlockAudit.assertHeld(); unlock?.assertHeld();
      const round = await audit.maintainRound({ observedAt, maxDurationMs: 60_000,
        // One complete current verification supplies this maintenance cycle's
        // graph and authorization. Reconciliation can recover a static graph
        // separately when authority is revoked; signing gates below stay fresh.
        verifyGraph: () => verifyBaseCollector(client, collector, { requireActivation: canary || !baseActivationAcceptanceReady(BASE_COLLECTOR_MANIFEST) ? false : "runtime",
          robinhoodClient: destination, auditStore: source }),
        verifyAuthority: async graph => {
          if (!execute && (canary ? graph.paused : !baseActivationAcceptanceReady(BASE_COLLECTOR_MANIFEST))) return false;
          if (!canary) return baseActivationAcceptanceReady(BASE_COLLECTOR_MANIFEST);
          await verifyBaseCollector(client, collector, { requireActivation: canary ? false : "runtime", allowCanary: canary,
            canaryOrigin: canary ? origin : undefined, robinhoodClient: destination, auditStore: source });
          return true;
        },
      });
      unlockAudit.assertHeld(); unlock?.assertHeld();
      projectionPublished = !!round.snapshot;
      const graph = round.graph;
      if (auditOnly) {
        console.log(JSON.stringify({ mode: "audit_only", chainId: 8453, custody: round.snapshot?.custody ?? null,
          activationVerified: round.activationVerified, published: projectionPublished }));
        if (!args.includes("--once") && !stopping) await new Promise(resolve => setTimeout(resolve, interval));
        continue;
      }
      const all = unionBatches(journal.batches, await allBaseFeeBatches(source),true);
      const persistLocal = async (batch: BaseFeeBatch) => { journal.batches = [...journal.batches.filter(row=>row.id!==batch.id),batch]; if (path) await writeBasePublicJson(path, journal); };
      const persistPublic = async (batch: BaseFeeBatch) => { await source.saveBuybackBatch(batch); };
      if (replacementHint && !all.some(batch => batch.id === replacementHint[1] && batch.journal && sameAddress(batch.journal.caller, account!.address))) throw new Error("The replacement hint does not identify this keeper’s retained native task");
      if (execute && graph) for (const resolved of await reconcileBaseKeeperHistory(journal,all,client,graph.runtimeHash,replacementHint?[replacementHint[1],replacementHint[2] as Hex]:undefined)) { await persistLocal(resolved); await persistPublic(resolved); }
      if (!graph || execute && !round.activationVerified) {
        // Acceptance controls new signatures, not this process's lifecycle or
        // recovery of transactions it already submitted.
        console.log(JSON.stringify({ mode: execute ? "execute_waiting_authority" : "dry_run", chainId: 8453,
          activationVerified: false, published: projectionPublished, state: "signing_deferred" }));
        if (!args.includes("--once") && !stopping) await new Promise(resolve => setTimeout(resolve, interval));
        continue;
      }
      const config = await audit.configuration();
      const current = unionBatches(journal.batches, await allBaseFeeBatches(source),true);
      if (execute) { assertBaseNoUnknown(current, account!.address); assertBaseKeeperRoles(account!.address, BASE_COLLECTOR_MANIFEST, config.treasury);
        await assertBaseKeeperAuthority(client,destination,BASE_COLLECTOR_MANIFEST,account!.address);
        await assertBaseOperationalControl(service.store, { config }, collector); }
      const tasks: BaseFeeBatch[] = [], now = Date.now();
      const policies = await readTrustedBaseRecoveryAssets(service,collector),policyFor=(asset: Address)=>policies.find(policy=>sameAddress(policy.address,asset));
      const recoveryContext = { policies,history: current,keeper: journal.keeper,now };
      const recoveryEnabled = !canary && untrackedCap > baseCanonicalGasSpent(current,journal.keeper,true);
      const seed = (kind: "claim" | "release" | "sync_untracked" | "release_untracked"): BaseFeeBatch => ({ id: `base-native-${randomUUID()}`, protocol: BASE_BUYBACK_PROTOCOL, sourceChainId: 8453, destinationChainId: 4663,
        collector, kind, status: "unknown", createdAt: now, updatedAt: now, amountIn: "0", receivedAmount: "0", refundedAmount: "0", burnedAmount: "0", claimHashes: [] });
      for (const token of await service.store.tokens()) if (token.feePolicy === BASE_AUTOMATION_FEE_POLICY && token.feeEngine && sameAddress(token.feeEngine, collector)) {
        if (!policyFor(token.address) || !policyFor(token.quoteAddress)) continue;
        try {
          const fees = await service.fees(token.address, collector);
          if ([fees.lp.fees0, fees.lp.fees1, fees.trade.fees0, fees.trade.fees1].some(value => value > 0n)) tasks.push({ ...seed("claim"), poolId: token.poolId });
          else if (recoveryEnabled) for (const asset of [token.address,token.quoteAddress]) {
            const policy = policyFor(asset)!;
            if (baseUntrackedAssetCooling(asset,"claim",recoveryContext)) continue;
            const [registered,untracked] = await Promise.all([client.readContract({ address: collector,abi: baseCollectorAbi,functionName: "verifiedAssets",args: [asset] }),
              client.readContract({ address: collector,abi: baseCollectorAbi,functionName: "untrackedBalance",args: [asset] })]);
            if (!registered && untracked >= integer(policy.minimumRaw)) { tasks.push({ ...seed("claim"),poolId: token.poolId,inputAsset: policy,recoveryRegistration: true });break; }
          }
        } catch { /* One unavailable pool cannot starve the other registered fee tasks. */ }
      }
      const status = await audit.engine();
      if (status.available && status.nativeAutomationState === "configured" && sameAddress(status.collector ?? "", collector) && status.automation && sameAddress(status.automation, graph.automationReceiver)) {
        const custody = await audit.custody();
        for (const asset of status.assets) if (policyFor(asset.address) && policyFor(asset.address)!.decimals === asset.decimals && integer(asset.pending, true) > 0n && baseReleaseAssetReady(custody, asset.address)) {
          assertBaseReleaseReadiness(custody, status, asset.address);
          tasks.push({ ...seed("release"), inputAsset: policyFor(asset.address), amountIn: asset.pending,
            release: { token: asset.address, amount: asset.pending, automation: graph.automationReceiver } });
        }
        if (recoveryEnabled) tasks.push(...baseUntrackedRecoveryTasks(status,seed,custody,canary,recoveryContext));
      }
      console.log(JSON.stringify({ mode: execute ? "execute" : "dry_run", chainId: 8453, tasks: tasks.map(task => ({ kind: task.kind, poolId: task.poolId, asset: task.inputAsset?.address, amount: task.amountIn })) }));
      if (execute && account) {
        const wallet = createWalletClient({ account, chain: base, transport: http(runtime.rpcUrl, { timeout: 30000, retryCount: 0 }) });
        for (const task of tasks) {
          if (baseTaskIsolated(task,unionBatches(journal.batches,current),account.address)) continue;
          const transaction = baseFeeTransaction(task);
          const prepared = await prepareBaseFeeTask(task,client,account.address,now); if (!prepared) continue;
          const latest = prepared.journal!.nonce,gas=BigInt(prepared.journal!.gasLimit),maxFeePerGas=BigInt(prepared.journal!.maxFeePerGas),reservation=prepared.gasReservation!;
          if (isBaseUntrackedTask(task) && !await assertCanonicalBaseUntrackedBudget(journal,prepared,source,untrackedCap)) continue;
          const gate = async (alreadyReserved = false) => {
            unlockAudit!.assertHeld(); unlock?.assertHeld();
            const fresh = await verifyBaseCollector(client, collector, { requireActivation: canary ? false : "runtime", allowCanary: canary, canaryOrigin: canary ? origin : undefined, robinhoodClient: destination,auditStore: source });
            if (fresh.manifestFingerprint !== graph.manifestFingerprint || fresh.paused || !sameAddress(fresh.automationReceiver, graph.automationReceiver)) throw new Error("The native fee graph changed or paused");
            audit.setVerifiedGraph(fresh, true);
            const currentConfig = await audit.configuration();
            assertBaseKeeperRoles(account.address, BASE_COLLECTOR_MANIFEST, currentConfig.treasury);
            await assertBaseKeeperAuthority(client,destination,BASE_COLLECTOR_MANIFEST,account.address);
            await assertBaseOperationalControl(service.store, { config: currentConfig }, collector);
            await assertBaseVaultCheckpoint(() => audit.vault());
            assertBaseNoUnknown(unionBatches(journal.batches, await allBaseFeeBatches(source),true).filter(row => row.id !== prepared.id), account.address);
            const custody = await audit.custody();
            assertNativeCustodyReadiness(custody);
            if (task.kind === "release" || task.kind === "release_untracked") {
              await assertBaseSelectedReleaseReadiness(client, prepared, custody);
            }
            if (task.inputAsset) {
              const approved = (await readTrustedBaseRecoveryAssets(service,collector,task.inputAsset.address)).find(policy=>sameAddress(policy.address,task.inputAsset!.address));
              if (!approved || approved.decimals !== task.inputAsset.decimals || await client.readContract({ address: approved.address,abi: erc20Abi,functionName: "decimals" }) !== approved.decimals)
                throw new BaseFeeAssetUnavailable("The automatic fee asset is not canonically registered with its exact precision");
              if (isBaseUntrackedTask(task)) {
                const liveHistory = unionBatches(journal.batches,await allBaseFeeBatches(source),true).filter(batch=>batch.id!==prepared.id);
                const kind = task.kind === "claim" ? "claim" : task.kind === "release_untracked" ? "release_untracked" : "sync_untracked";
                if (baseUntrackedAssetCooling(approved.address,kind,{ ...recoveryContext,history: liveHistory,now: Date.now() })) throw new BaseFeeAssetUnavailable("Unknown asset recovery is within its durable cooldown");
                const [registered,balance] = await Promise.all([client.readContract({ address: collector,abi: baseCollectorAbi,functionName: "verifiedAssets",args: [approved.address] }),
                  client.readContract({ address: collector,abi: baseCollectorAbi,functionName: task.kind === "release_untracked" ? "pendingUntracked" : "untrackedBalance",args: [approved.address] })]);
                if (task.recoveryRegistration ? registered || balance < integer(approved.minimumRaw) : !registered || balance < integer(approved.minimumRaw))
                  throw new BaseFeeAssetUnavailable("Unknown asset registration or raw recovery minimum no longer qualifies");
              }
            }
            await assertBaseGasReservationCurrent(client, transaction, latest, gas, maxFeePerGas, reservation);
            const cap = fresh.canaryAuthorization ? BigInt(fresh.canaryAuthorization.maxBaseGasWei) < BigInt(rawCap!) ? BigInt(fresh.canaryAuthorization.maxBaseGasWei) : BigInt(rawCap!) : BigInt(rawCap!);
            // The new task is already included in durable source history before broadcast.
            const budgetJournal = alreadyReserved ? { ...journal, batches: journal.batches.filter(row => row.id !== prepared.id) } : journal;
            if (isBaseUntrackedTask(prepared)) {
              if (canary || fresh.canaryAuthorization) throw new Error("Private canary does not authorize unknown recovery");
              if (!await assertCanonicalBaseUntrackedBudget(budgetJournal,prepared,source,untrackedCap)) throw new BaseUntrackedBudgetExhausted("Independent unknown gas budget exhausted");
              const budgetHistory = unionBatches(budgetJournal.batches,await allBaseFeeBatches(source),true).filter(row=>row.id!==prepared.id);
              if (!baseUntrackedWalletHasReserve(await client.getBalance({ address: account.address,blockTag: "latest" }),reservation.totalWei,cap,budgetHistory,account.address))
                throw new BaseUntrackedBudgetExhausted("Unknown recovery would consume the ETH reserved for the remaining genuine fee budget");
            } else {
              if (await client.getBalance({ address: account.address,blockTag: "latest" }) < integer(reservation.totalWei,true)) throw new Error("The keeper lacks the reserved Base gas; fund the reviewed keeper before submitting");
              await assertCanonicalBaseCanaryBudget(budgetJournal, prepared, source, client, cap, fresh.canaryAuthorization, BigInt(fresh.initialDeploymentBlock));
            }
            unlockAudit!.assertHeld(); unlock?.assertHeld();
          };
          let submitted: BaseFeeBatch;
          try { await gate();submitted = await submitBaseFeeBatch(prepared, { sign: async () => { await gate(); unlockAudit!.assertHeld(); unlock?.assertHeld(); return wallet.signTransaction({ ...transaction, nonce: latest, gas, maxFeePerGas, maxPriorityFeePerGas: 1n, type: "eip1559" }); },
            persistLocal, persistPublic, beforeBroadcast: async () => { await gate(true); unlockAudit!.assertHeld(); unlock?.assertHeld(); },
            broadcast: raw => wallet.sendRawTransaction({ serializedTransaction: raw }) });
          } catch (error) { if (error instanceof BaseUntrackedBudgetExhausted || error instanceof BaseFeeAssetUnavailable) continue; throw error; }
          if (submitted.status === "abandoned") continue;
          await client.waitForTransactionReceipt({ hash: submitted.sourceHash!, confirmations: 2, timeout: 30000, pollingInterval: 1000 }).catch(() => undefined);
          const resolved = await reconcileBaseFeeBatch(submitted, client, undefined, graph.runtimeHash); await persistLocal(resolved); await persistPublic(resolved); assertBaseNoUnknown([resolved], account.address);
        }
      }
      } catch (error) {
        if (!projectionPublished) await audit.publishFailure(observedAt).catch(() => {});
        if (error instanceof BaseProcessLeaseLostError || !auditOnly || args.includes("--once")) throw error;
        // Audit-only has no nonce or signature outcome. Persisted complete
        // pages survive temporary provider errors and resume next round.
        console.error(redact(error));
      }
      if (!args.includes("--once") && !stopping) await new Promise(resolve => setTimeout(resolve, interval));
    } while (!args.includes("--once") && !stopping);
  } finally { try { await audit.close(); await source.close(); await service.store.close(); }
    finally { try { await unlock?.(); } finally { await unlockAudit?.(); } } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runBaseBuybackKeeper().catch(error => { console.error(redact(error)); process.exitCode = 1; });
