import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, parseAbi, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction,
  type Address, type Hex, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, robinhood } from "viem/chains";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_WETH, BASE_BUYBACK_RH_WETH, baseCollectorAbi, integer, type BaseCollectorStatus, type BaseFeeAsset, type BaseFeeBatch, type BaseGasReservation } from "../src/lib/base-buyback";
import { CONTRACTS, STOCKS, sameAddress, type TokenRecord } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import { BASE_COLLECTOR_MANIFEST, verifyBaseCollectorForKeeperStartup, assertBaseKeeperLiveAuthority } from "../server/base-collector";
import { BASE_GAS_PRICE_ORACLE, BASE_RECOVERY_FIXED_ASSETS, BaseFeeQuoteReader, baseGasPriceOracleAbi, canonicalBaseReceipt, collectorClaimEvidence, collectorReleaseEvidence, collectorUntrackedSyncEvidence, readCanonicalBaseTransactionFee, type BaseRecoveryAssetPolicy } from "../server/base-buyback";
import { loadEnvironment, redact, runtimeFromEnv, type Runtime, type RuntimeEnvironment } from "../server/config";
import { SupabaseStore, type StoreBackend } from "../server/supabase-store";
import { FirstBuyPaymentReader } from "../server/lifi";
import { alchemyRpcTransport, createRpcMetrics } from "../server/alchemy-rpc";
import { DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { assertKeeperNonceReady, keeperTaskWait, recordKeeperTaskOutcome, type KeeperJournal, type KeeperTaskStateFile } from "./buyback-keeper";
import { KEEPER_TASK_RETRY_POLICY } from "./keeper-task-policy";
export { KEEPER_TASK_RETRY_POLICY } from "./keeper-task-policy";
import { monitorKeeperBalance } from "./keeper-balance-alerts";
import { acquireBaseProcessLease, BaseProcessLeaseLostError, type BaseProcessLease } from "./base-process-lease";

type Client = PublicClient<Transport, any>;
export type BaseKeeperJournal = { version: 2; collector: Address; keeper: Address; batches: BaseFeeBatch[] };
export function baseCanonicalKeeperLease(collector: Address, keeper: Address) {
  return join(homedir(), ".codex", "base-native-keeper", `${collector.toLowerCase()}-${keeper.toLowerCase()}.json`);
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
/** Only the selected fixed fee bucket is checked; no cross-chain attribution gate. */
export async function assertBaseSelectedReleaseReadiness(client: Client, task: BaseFeeBatch) {
  if (!task.release || !["release", "release_untracked"].includes(task.kind) || !sameAddress(task.release.token, task.inputAsset?.address ?? "") ||
    task.release.amount !== task.amountIn) throw new BaseFeeAssetUnavailable("This selected release asset is invalid");
  const [registered, pending] = await Promise.all([
    client.readContract({ address: task.collector, abi: baseCollectorAbi, functionName: "verifiedAssets", args: [task.release.token] }),
    client.readContract({ address: task.collector, abi: baseCollectorAbi, functionName: task.kind === "release" ? "pendingFees" : "pendingUntracked", args: [task.release.token] }),
  ]);
  if (registered !== true || typeof pending !== "bigint" || pending < integer(task.amountIn)) throw new BaseFeeAssetUnavailable("The selected canonical fee bucket is unavailable or insufficient");
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
function hasBaseActualGasBinding(batch: BaseFeeBatch) {
  return !!batch.actualGas && batch.actualGas.transactionHash === batch.sourceHash &&
    batch.actualGas.blockNumber === batch.sourceBlockNumber && batch.actualGas.blockHash === batch.sourceBlockHash;
}
function baseSourceUpdatedAt(batch: BaseFeeBatch, now = Date.now()) {
  return Math.max(now, batch.updatedAt + 1);
}
function baseSourceOutcomeAt(batch: BaseFeeBatch) {
  const outcome = batch.sourceOutcome;
  if (outcome && (!Number.isSafeInteger(outcome.at) || outcome.at <= 0 || outcome.transactionHash !== batch.sourceHash ||
    outcome.blockNumber !== batch.sourceBlockNumber || outcome.blockHash !== batch.sourceBlockHash || !hasBaseActualGasBinding(batch)))
    throw new Error("Canonical task outcome time is not bound to its actual gas receipt");
  const at = outcome?.at ?? batch.updatedAt;
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error("Canonical task outcome time is invalid");
  return at;
}
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
    const retainedOutcome = hasBaseActualGasBinding(batch) && batch.sourceHash === hash &&
      batch.sourceBlockNumber === String(receipt.blockNumber) && batch.sourceBlockHash === receipt.blockHash;
    const next: BaseFeeBatch = { ...batch, sourceHash: hash, sourceBlockNumber: String(receipt.blockNumber), sourceBlockHash: receipt.blockHash,
      actualGas, updatedAt: baseSourceUpdatedAt(batch), error: undefined,evidenceRetryAt: undefined,sourceFinalized: undefined,
      sourceOutcome: { at: retainedOutcome ? baseSourceOutcomeAt(batch) : Date.now(), transactionHash: hash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash },
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
  } catch {
    // Preserve the old proven tuple's time through a transport outage. This
    // metadata cannot settle an outcome: status remains globally unresolved.
    let sourceOutcome = batch.sourceOutcome;
    if (!sourceOutcome && hasBaseActualGasBinding(batch)) sourceOutcome = { at: baseSourceOutcomeAt(batch), transactionHash: batch.sourceHash!, blockNumber: batch.sourceBlockNumber!, blockHash: batch.sourceBlockHash! };
    return { ...batch, ...(sourceOutcome ? { sourceOutcome } : {}), sourceFinalized: undefined,status: batch.sourceBlockHash ? "reorg" : "unknown", error: "Source transaction or fee evidence remains unresolved.", updatedAt: baseSourceUpdatedAt(batch) };
  }
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
  const candidates = own.filter(batch=>batch.id===replacementHint?.[0] || (retryEvidence(batch) ? !batch.evidenceRetryAt || now>=batch.evidenceRetryAt : !terminal(batch)||!batch.sourceFinalized))
    .sort((a,b)=>Number(knownMined(a))-Number(knownMined(b)) || (knownMined(a)&&knownMined(b) ? (a.evidenceRetryAt??0)-(b.evidenceRetryAt??0) : 0) || a.journal!.nonce-b.journal!.nonce || a.createdAt-b.createdAt);
  if (!candidates.length) return []; // Settled finalized tasks require no daily historical RPC.
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.number === null || !finalized.hash) throw new Error("Canonical finalized source head is unavailable; retained outcomes were not changed");
  const lastAnchor = own.filter(batch=>knownMined(batch)&&batch.sourceFinalized&&batch.sourceBlockNumber&&batch.sourceBlockHash)
    .sort((a,b)=>BigInt(a.sourceBlockNumber!) < BigInt(b.sourceBlockNumber!) ? 1 : -1)[0];
  if (lastAnchor && (finalized.number < BigInt(lastAnchor.sourceBlockNumber!) || (await client.getBlock({ blockNumber: BigInt(lastAnchor.sourceBlockNumber!) })).hash !== lastAnchor.sourceBlockHash))
    throw new Error("Finalized source anchor is unavailable or changed; retained outcomes require audited recovery");
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
      result = { ...batch,sourceOutcome: result.sourceOutcome ?? batch.sourceOutcome,status: "evidence_pending",evidenceRetryAt: now+BASE_EVIDENCE_RETRY_MS,updatedAt: baseSourceUpdatedAt(batch, now),error: "Retained mined source is canonical; asset evidence RPC remains pending." };
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
export function baseUntrackedWalletHasReserve(balance: bigint,reservation: string) {
  return balance >= integer(reservation,true) + KEEPER_TASK_RETRY_POLICY.maximumAttemptGasWei;
}
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
export function baseKeeperTaskKey(task: BaseFeeBatch) {
  baseFeeTransaction(task);
  if (isBaseUntrackedTask(task)) throw new Error("The genuine-fee task policy does not permit unknown recovery");
  return task.kind === "claim" ? `claim:${task.poolId!.toLowerCase()}` : `release:${task.inputAsset!.address.toLowerCase()}`;
}
/** The original journals remain the retry ledger. A new file or random batch
 * identifier cannot reset a pool/asset's canonical failed-gas window. */
export function baseKeeperTaskState(history: BaseFeeBatch[], keeper: Address, now = Date.now()): KeeperTaskStateFile {
  let state: KeeperTaskStateFile = { schemaVersion: 1, chainId: 8453, caller: keeper, tasks: {} };
  const cutoff = now - KEEPER_TASK_RETRY_POLICY.gasWindowMs;
  const outcomes = new Map<string, { batch: BaseFeeBatch; at: number }>();
  for (const batch of history) {
    if (batch.protocol !== BASE_BUYBACK_PROTOCOL || batch.sourceChainId !== 8453 || !isBaseSourceTask(batch) || isBaseUntrackedTask(batch) ||
      !batch.journal || !sameAddress(batch.journal.caller, keeper) || !["claimed", "released", "reverted", "cancelled", "asset_failed"].includes(batch.status)) continue;
    const hint = batch.sourceOutcome?.at ?? batch.updatedAt;
    const expired = Number.isSafeInteger(hint) && hint > 0 && hint <= cutoff;
    let at: number;
    try {
      at = baseSourceOutcomeAt(batch);
      const fee = batch.actualGas;
      if (!fee || fee.transactionHash !== batch.sourceHash || fee.blockNumber !== batch.sourceBlockNumber || fee.blockHash !== batch.sourceBlockHash ||
        !batch.sourceHash || !batch.sourceBlockNumber || !batch.sourceBlockHash || integer(fee.totalWei, true) !==
        integer(fee.executionWei, true) + integer(fee.l1Wei, true) + integer(fee.operatorWei, true)) throw new Error("Canonical task outcome lacks complete actual gas evidence");
      if (!Number.isSafeInteger(batch.journal.nonce) || batch.journal.nonce < 0) throw new Error("Canonical task outcome nonce is invalid");
      baseKeeperTaskKey(batch);
    } catch (error) { if (expired) continue; throw error; }
    // Keep valid older aliases until their shared canonical tuple has its
    // earliest time. Filtering them first would extend legacy retry windows.
    const key = JSON.stringify([keeper.toLowerCase(), batch.journal.nonce, batch.sourceHash, batch.sourceBlockNumber, batch.sourceBlockHash]);
    const prior = outcomes.get(key);
    if (prior && (prior.batch.actualGas!.totalWei !== batch.actualGas!.totalWei || baseKeeperTaskKey(prior.batch) !== baseKeeperTaskKey(batch))) {
      // An expired conflicting payload cannot invalidate or move the current
      // task's valid window. Active conflicting financial evidence fails closed.
      if (at <= cutoff) continue;
      if (prior.at > cutoff) throw new Error("Canonical task nonce has conflicting outcomes");
      outcomes.set(key,{batch,at});continue;
    }
    outcomes.set(key,{ batch: prior && prior.batch.updatedAt > batch.updatedAt ? prior.batch : batch, at: Math.min(prior?.at ?? at, at) });
  }
  const active = [...outcomes.values()].filter(row => row.at > cutoff);
  const nonces = new Set<number>();
  for (const {batch,at} of active.sort((a, b) => a.at - b.at || a.batch.journal!.nonce - b.batch.journal!.nonce)) {
    if (nonces.has(batch.journal!.nonce)) throw new Error("Canonical task nonce has conflicting outcomes");
    nonces.add(batch.journal!.nonce);
    const journal: KeeperJournal = { schemaVersion: 1, chainId: 8453, caller: keeper, nonce: batch.journal!.nonce,
      taskId: baseKeeperTaskKey(batch), hash: batch.sourceHash!, to: batch.collector, dataHash: batch.journal!.dataHash, value: "0",
      gasLimit: batch.journal!.gasLimit, gasPrice: batch.journal!.maxFeePerGas, signedAt: batch.journal!.signedAt,
      status: ["claimed", "released"].includes(batch.status) ? "confirmed" : "reverted", blockNumber: batch.sourceBlockNumber,
      blockHash: batch.sourceBlockHash, gasSpent: batch.actualGas!.totalWei, resolvedAt: at };
    state = recordKeeperTaskOutcome(state, journal);
  }
  return state;
}
export function baseKeeperAttemptWait(reservation: BaseGasReservation, keeper: Address, now = Date.now()) {
  if (!reservation || integer(reservation.totalWei, true) !== integer(reservation.executionWei, true) +
    integer(reservation.l1Wei, true) + integer(reservation.operatorWei, true)) throw new Error("The task gas reservation is incomplete or inconsistent");
  return keeperTaskWait({schemaVersion:1,chainId:8453,caller:keeper,tasks:{}},"attempt",integer(reservation.totalWei,true),now);
}
export function baseKeeperTaskWait(history: BaseFeeBatch[], task: BaseFeeBatch, keeper: Address, now = Date.now()) {
  if (!task.gasReservation) throw new Error("A complete task gas reservation is required");
  const attempt = baseKeeperAttemptWait(task.gasReservation,keeper,now);
  if (attempt) return attempt;
  return keeperTaskWait(baseKeeperTaskState(history, keeper, now), baseKeeperTaskKey(task), integer(task.gasReservation.totalWei, true), now);
}
export async function assertCanonicalBaseTaskGasPolicy(journal: BaseKeeperJournal, next: BaseFeeBatch,
  store: Pick<StoreBackend, "buybackBatchPage">, now = Date.now()) {
  const all = unionBatches(journal.batches, await allBaseFeeBatches(store), true).filter(batch => batch.id !== next.id);
  assertBaseNoUnknown(all, journal.keeper);
  const wait = baseKeeperTaskWait(all, next, journal.keeper, now);
  if (wait) throw new Error(`${wait.reason}; nextAttemptAt=${wait.nextAttemptAt}`);
}
/** Unknown recovery retains its independent explicit gas ceiling and cooldown. */
export const BASE_UNTRACKED_COOLDOWN_MS = 3_600_000;
type UntrackedRecoveryContext = { policies: readonly BaseRecoveryAssetPolicy[]; history: BaseFeeBatch[]; keeper: Address; now: number };
export function baseUntrackedAssetCooling(asset: Address,kind: "sync_untracked"|"release_untracked"|"claim",context: UntrackedRecoveryContext) {
  return context.history.some(batch=>isBaseUntrackedTask(batch)&&batch.journal&&sameAddress(batch.journal.caller,context.keeper)&&batch.inputAsset&&sameAddress(batch.inputAsset.address,asset)&&
    !isBaseAbandonedTask(batch)&&
    ((batch.kind === kind)||(kind === "sync_untracked" && batch.kind === "release_untracked"))&&context.now < batch.createdAt + BASE_UNTRACKED_COOLDOWN_MS);
}
function feeAsset(policy: BaseFeeAsset): BaseFeeAsset {
  return { chainId: policy.chainId, address: policy.address, symbol: policy.symbol, decimals: policy.decimals };
}
export function baseUntrackedRecoveryTasks(status: BaseCollectorStatus, seed: (kind: "sync_untracked" | "release_untracked") => BaseFeeBatch,
  context?: UntrackedRecoveryContext): BaseFeeBatch[] {
  if (!context || !status.available || status.paused || !status.automation) return [];
  const tasks: BaseFeeBatch[] = [];
  for (const asset of status.assets) {
    const policy = context.policies.find(policy=>sameAddress(policy.address,asset.address));
    if (!policy || policy.decimals !== asset.decimals || !asset.verifiedAsset) continue;
    if (integer(asset.pendingUntracked ?? "0",true) >= integer(policy.minimumRaw) && !baseUntrackedAssetCooling(asset.address,"release_untracked",context))
      tasks.push({ ...seed("release_untracked"),inputAsset: feeAsset(policy),amountIn: asset.pendingUntracked!,release: { token: asset.address,amount: asset.pendingUntracked!,automation: status.automation } });
    else if (integer(asset.untracked ?? "0",true) >= integer(policy.minimumRaw) && !baseUntrackedAssetCooling(asset.address,"sync_untracked",context)) tasks.push({ ...seed("sync_untracked"),inputAsset: feeAsset(policy),amountIn: "0" });
  }
  return tasks.filter(task=>!baseTaskIsolated(task,context.history,context.keeper));
}
export const BASE_KEEPER_INTERVAL_MS = 300_000;
export const BASE_STUCK_MONITOR_INTERVAL_MS = 900_000;
export const BASE_STUCK_AFTER_MS = 86_400_000;
export type BaseStuckMonitor = { version: 1; collector: Address; lastReadAt: number; poolCursor: number;
  startupRetry?: { failures: number; nextAttemptAt: number };
  balances: Record<string, { amount: string; overSince: number; alertedAt?: number }> };
export function baseKeeperTokenEligible(token: TokenRecord, collector: Address) {
  return token.mode === "base" && token.deploymentChainId === 8453 && token.feePolicy === BASE_AUTOMATION_FEE_POLICY &&
    !!token.feeEngine && sameAddress(token.feeEngine, collector) && /^0x[\da-f]{40}$/i.test(token.address) &&
    STOCKS.some(stock => sameAddress(stock.address, token.quoteAddress)) &&
    typeof token.transactionHash === "string" && /^0x[\da-f]{64}$/i.test(token.transactionHash) &&
    typeof token.blockNumber === "string" && /^\d+$/.test(token.blockNumber) && /^0x[\da-f]{64}$/i.test(token.poolId);
}
export function baseKeeperPolicies(tokens: TokenRecord[], collector: Address): BaseRecoveryAssetPolicy[] {
  const values = new Map(BASE_RECOVERY_FIXED_ASSETS.map(asset => [asset.address.toLowerCase(), asset]));
  for (const token of tokens) if (baseKeeperTokenEligible(token, collector))
    values.set(token.address.toLowerCase(), { chainId: 8453, address: token.address, symbol: token.symbol.slice(0, 64), decimals: 18, minimumRaw: "1000000000000000000" });
  return [...values.values()];
}
/** The real quiet-round read path, also usable by explicit offline/CU probes.
 * It neither starts a service nor performs startup verification or writes. */
export async function readBaseKeeperFeeRound(reader: Pick<BaseFeeQuoteReader, "status">, tokens: TokenRecord[], collector: Address,
  poolCursor: number, preview: (token: TokenRecord) => Promise<bigint>) {
  const status = await reader.status();
  if (!status.available || status.stale) throw new Error("Current Collector counters are unavailable; pending");
  const eligible = tokens.filter(token => baseKeeperTokenEligible(token, collector));
  const claims: { token: TokenRecord; asset: BaseRecoveryAssetPolicy }[] = [], failures: unknown[] = [];
  for (let index = 0; index < Math.min(2, eligible.length); index++) {
    const token = eligible[(poolCursor + index) % eligible.length], asset = BASE_RECOVERY_FIXED_ASSETS.find(asset => sameAddress(asset.address, token.quoteAddress));
    if (!asset) continue;
    try { if (await preview(token) > 0n) claims.push({ token, asset }); } catch (error) { failures.push(error); }
  }
  return { status, claims, failures, poolCursor: eligible.length ? (poolCursor + Math.min(2, eligible.length)) % eligible.length : 0 };
}
export function updateBaseStuckMonitor(previous: BaseStuckMonitor, readings: { key: string; amount: string; threshold: string }[], now: number,
  stuckAfterMs = BASE_STUCK_AFTER_MS) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(stuckAfterMs) || stuckAfterMs < BASE_STUCK_MONITOR_INTERVAL_MS)
    throw new Error("Invalid stuck-funds observation time");
  const balances = { ...previous.balances }, alerts: { key: string; amount: string; overSince: number }[] = [];
  for (const row of readings) {
    const amount = integer(row.amount, true), threshold = integer(row.threshold), retained = balances[row.key];
    if (amount < threshold) { delete balances[row.key]; continue; }
    const next = { amount: row.amount, overSince: retained?.overSince ?? now, ...(retained?.alertedAt !== undefined ? { alertedAt: retained.alertedAt } : {}) };
    if (next.alertedAt === undefined && now - next.overSince >= stuckAfterMs) { alerts.push({ key: row.key, amount: row.amount, overSince: next.overSince }); next.alertedAt = now; }
    balances[row.key] = next;
  }
  return { state: { ...previous, lastReadAt: now, balances }, alerts };
}
export function baseStartupRetry(previous: BaseStuckMonitor["startupRetry"], now: number) {
  const failures = Math.min(8, (previous?.failures ?? 0) + 1);
  return { failures, nextAttemptAt: now + Math.min(3_600_000, BASE_KEEPER_INTERVAL_MS * 2 ** (failures - 1)) };
}
async function appendFundAlert(path: string, alert: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "a", 0o600);
  try { await file.writeFile(JSON.stringify(alert) + "\n"); await file.sync(); } finally { await file.close(); }
  console.log(JSON.stringify(alert));
}
export function sortBaseKeeperTasks(tasks: BaseFeeBatch[]) {
  const priority = (task: BaseFeeBatch) => task.kind === "release" ? 0 : task.kind === "release_untracked" ? 1 : task.kind === "claim" ? 2 : 3;
  return [...tasks].sort((a, b) => priority(a) - priority(b));
}
export function baseClaimCoversGas(minimumWeth: bigint, reservation: BaseGasReservation) {
  return minimumWeth > integer(reservation.totalWei, true);
}
/** Read-only pricing, never signable calldata. Only the verified paired leg
 * contributes value; the newly issued meme leg is conservatively worth zero. */
export async function baseClaimValueWeth(reader: Pick<FirstBuyPaymentReader, "pricingRequest" | "integrator">,
  asset: BaseFeeAsset, amount: bigint, automation: Address, now = Date.now): Promise<bigint> {
  if (amount <= 0n) return 0n;
  if (sameAddress(asset.address, BASE_BUYBACK_WETH)) return amount;
  const pinned = STOCKS.find(stock => sameAddress(stock.address, asset.address));
  if (!pinned || pinned.decimals !== asset.decimals) throw new Error("Claim paired-asset valuation is unavailable");
  const started = now();
  const raw = await reader.pricingRequest("quote", new URLSearchParams({ fromChain: "8453", toChain: "8453", fromToken: pinned.address,
    toToken: BASE_BUYBACK_WETH, fromAmount: String(amount), fromAddress: automation, toAddress: automation,
    integrator: reader.integrator, fee: "0", slippage: "0.01", skipSimulation: "false", allowBridges: "none" })) as any;
  const action = raw?.action, estimate = raw?.estimate;
  if (now() < started || now() >= started + 60_000 || action?.fromChainId !== 8453 || action?.toChainId !== 8453 ||
    !sameAddress(action.fromAddress ?? "", automation) || !sameAddress(action.toAddress ?? "", automation) || action.fromAmount !== String(amount) ||
    !sameAddress(action.fromToken?.address ?? "", pinned.address) || action.fromToken?.decimals !== pinned.decimals || action.fromToken?.chainId !== 8453 ||
    !sameAddress(action.toToken?.address ?? "", BASE_BUYBACK_WETH) || action.toToken?.decimals !== 18 || action.toToken?.chainId !== 8453 ||
    estimate?.fromAmount !== String(amount)) throw new Error("Claim valuation quote changed its chain, assets, amount or freshness");
  const minimum = integer(estimate.toAmountMin), expected = integer(estimate.toAmount);
  if (minimum > expected) throw new Error("Invalid conservative claim value");
  return minimum;
}
export async function pendingPairedFees(sdk: DopplerSDK<8453>, token: TokenRecord, collector: Address) {
  const pool = await sdk.getMulticurvePool(token.address), hook = await sdk.getRehypeDopplerHookInitializer(CONTRACTS.rehype);
  const [lp, trade] = await Promise.all([pool.getPendingFees(collector), hook.getPendingFees(token.poolId, collector)]);
  const amount = BigInt(token.address) < BigInt(token.quoteAddress) ? lp.fees1 + trade.fees1 : lp.fees0 + trade.fees0;
  if (typeof amount !== "bigint" || amount < 0n) throw new Error("Canonical paired fee quantity unavailable");
  return amount;
}
export async function runBaseBuybackKeeper(args = process.argv.slice(2)) {
  const execute = args.includes("--execute"), auditOnly = args.includes("--audit-only");
  if (execute && auditOnly) throw new Error("Audit-only mode cannot sign or broadcast");
  const names = ["interval", "operator-dir", "max-untracked-gas-wei", "replacement"];
  if (args.some(arg => !["--execute", "--audit-only", "--once", "--help"].includes(arg) && !names.some(name => arg.startsWith(`--${name}=`)))) throw new Error("Unsupported Base keeper option");
  for (const name of names) if (args.filter(arg => arg.startsWith(`--${name}=`)).length > 1) throw new Error(`Select only one --${name} value`);
  if (args.includes("--help")) { console.log("Base fee keeper: --audit-only [--once] [--interval=300000] [--operator-dir=/private/path]. Five-minute counters and fee tasks only; no custody, tracing, observer or source attribution. Startup verification is persisted once. --execute additionally requires an isolated keeper key and live owner/control permission. Genuine fees use the shared single-attempt and rolling failed-gas policy, with no lifetime ceiling. Optional --max-untracked-gas-wei is a separate unknown recovery cap; omission disables it. --replacement=<batchId>:<hash> recovers one retained same-nonce transaction. No local swap or bridge signing."); return; }
  if (!BASE_COLLECTOR_MANIFEST.collector.address || BASE_COLLECTOR_MANIFEST.status !== "deployed_verified") {
    if (execute) throw new Error("Base fee adapter is not deployed; no transaction was signed");
    console.log(JSON.stringify({ mode: "audit_only", state: "not_deployed", chainId: 8453 })); return;
  }
  if (!execute) loadEnvironment(); else assertBaseRoleSecrets(process.env);
  const interval = Number(args.find(arg => arg.startsWith("--interval="))?.slice(11) ?? BASE_KEEPER_INTERVAL_MS);
  if (!Number.isSafeInteger(interval) || interval < BASE_KEEPER_INTERVAL_MS || interval > 3_600_000) throw new Error("Keeper interval must be at least five minutes");
  const rawUntrackedCap = args.find(arg => arg.startsWith("--max-untracked-gas-wei="))?.slice("--max-untracked-gas-wei=".length);
  const untrackedCap = rawUntrackedCap === undefined ? 0n : integer(rawUntrackedCap);
  const hint = args.find(arg => arg.startsWith("--replacement="))?.slice(14), replacementHint = hint?.match(/^([^:]{1,200}):(0x[\da-f]{64})$/i);
  if (hint && (!execute || !replacementHint)) throw new Error("A replacement hint requires --execute and the exact batchId:transactionHash");
  const runtime = runtimeFromEnv(8453, { ...process.env, CHAIN_MODE: "base" });
  if (runtime.dataScope !== "base" || runtime.config.mode !== "base") throw new Error("The lightweight keeper uses only canonical Base scope");
  const metrics = createRpcMetrics();
  const client = createPublicClient({ chain: base, transport: alchemyRpcTransport(8453, runtime.environment ?? {}, { metrics }), batch: { multicall: true } });
  const destination = createPublicClient({ chain: robinhood, transport: alchemyRpcTransport(4663, runtime.environment ?? {}, { metrics }), batch: { multicall: true } });
  const source = baseSourceStore(runtime), collector = BASE_COLLECTOR_MANIFEST.collector.address;
  const sdk = new DopplerSDK<8453>({ publicClient: client, chainId: 8453 });
  const quotes = new FirstBuyPaymentReader({ client, chainId: 8453, integrator: runtime.lifi.integrator, apiKey: runtime.lifi.apiKey, budget: source });
  const account = execute ? privateKeyToAccount(process.env.MUSEGOD_KEEPER_PRIVATE_KEY as Hex) : null;
  const keeper = account?.address ?? BASE_COLLECTOR_MANIFEST.activation?.trustedSplitsAcceptance?.keeper ?? "0x0000000000000000000000000000000000000001";
  if (account) assertBaseKeeperRoles(account.address, BASE_COLLECTOR_MANIFEST, runtime.config.treasury);
  const path = baseCanonicalKeeperLease(collector, keeper), operatorDirectory = resolve(args.find(arg => arg.startsWith("--operator-dir="))?.slice(15) ?? dirname(path));
  const observationPath = join(operatorDirectory, "base-keeper-observations.json"), alertPath = join(operatorDirectory, "base-keeper-alerts.jsonl");
  let unlock: BaseProcessLease | null = null;
  let journal: BaseKeeperJournal = { version: 2, collector, keeper, batches: [] };
  let observations = await readBasePublicJson<BaseStuckMonitor>(observationPath) ?? { version: 1, collector, lastReadAt: 0, poolCursor: 0, balances: {} };
  if (observations.version !== 1 || !sameAddress(observations.collector, collector) || !Number.isSafeInteger(observations.poolCursor) || observations.poolCursor < 0 ||
    !Number.isSafeInteger(observations.lastReadAt) || !observations.balances || typeof observations.balances !== "object") throw new Error("Private keeper observation identity changed");
  if (observations.startupRetry && (!Number.isSafeInteger(observations.startupRetry.failures) || observations.startupRetry.failures < 0 || observations.startupRetry.failures > 8 || !Number.isSafeInteger(observations.startupRetry.nextAttemptAt) || observations.startupRetry.nextAttemptAt < 0)) { delete observations.startupRetry; }
  let graph: Awaited<ReturnType<typeof verifyBaseCollectorForKeeperStartup>> | undefined, reader: BaseFeeQuoteReader | undefined;
  let policies = [...BASE_RECOVERY_FIXED_ASSETS], stopping = false, wake: (() => void) | undefined;
  const stop = () => { stopping = true; wake?.(); }; process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const deferred = (reason: unknown, task?: BaseFeeBatch) => console.log(JSON.stringify({ mode: execute ? "execute" : "audit_only", chainId: 8453,
    state: "signing_deferred", ...(task ? { taskId: task.id, kind: task.kind } : {}), reason: redact(reason, runtime.environment) }));
  const persistLocal = async (batch: BaseFeeBatch) => { journal.batches = [...journal.batches.filter(row => row.id !== batch.id), batch]; if (execute) await writeBasePublicJson(path, journal); };
  const persistPublic = async (batch: BaseFeeBatch) => { if (execute) await source.saveBuybackBatch(batch); };
  try {
    if (execute) { unlock = await acquireBaseProcessLease(path); journal = await readBasePublicJson<BaseKeeperJournal>(path) ?? journal; }
    if (journal.version !== 2 || !sameAddress(journal.collector, collector) || !sameAddress(journal.keeper, keeper) || !Array.isArray(journal.batches)) throw new Error("The keeper journal identity changed");
    do {
      metrics.reset(); const observedAt = Date.now();
      try {
        unlock?.assertHeld();
        if (!graph) {
          if (observedAt < (observations.startupRetry?.nextAttemptAt ?? 0)) throw new Error(`One-time startup verification is deferred until ${observations.startupRetry!.nextAttemptAt}`);
          try { graph = await verifyBaseCollectorForKeeperStartup(client, destination, { auditStore: source, collector }); }
          catch (error) {
            observations = { ...observations, startupRetry: baseStartupRetry(observations.startupRetry, observedAt) };
            await writeBasePublicJson(observationPath, observations).catch(() => undefined); // Scheduling IO cannot authorize a signature.
            throw error;
          }
          if (observations.startupRetry) { delete observations.startupRetry; await writeBasePublicJson(observationPath, observations).catch(() => console.log(JSON.stringify({ mode: "startup_schedule_pending", reason: "Startup verified; private scheduling persistence is temporarily unavailable." }))); }
          // Startup's one-time work is reported separately from a steady round.
          console.log(JSON.stringify({ mode: "startup_verified", chainId: 8453, rpc: metrics.snapshot() })); metrics.reset();
          reader = new BaseFeeQuoteReader({ client, collector, verifiedGraph: graph, assets: async () => policies, includeTaskState: true });
        }
        const tokens = (await source.tokens()).filter(token => baseKeeperTokenEligible(token, collector));
        policies = baseKeeperPolicies(tokens, collector);
        const round = await readBaseKeeperFeeRound(reader!, tokens, collector, observations.poolCursor, token => pendingPairedFees(sdk, token, collector));
        const status = round.status;
        for (const failure of round.failures) deferred(failure);
        const current = unionBatches(journal.batches, execute ? await allBaseFeeBatches(source) : [], true);
        if (observedAt - observations.lastReadAt >= BASE_STUCK_MONITOR_INTERVAL_MS) {
          try {
            if (!status.assetsComplete) throw new Error("Automation balances are incomplete");
            const treasury = await destination.readContract({ address: BASE_BUYBACK_RH_WETH, abi: erc20Abi, functionName: "balanceOf", args: [BASE_COLLECTOR_MANIFEST.constants.destinationTreasury!] });
            if (typeof treasury !== "bigint" || treasury < 0n) throw new Error("Treasury balance is unavailable");
            const readings = status.assets.map(asset => ({ key: `8453:automation:${asset.address.toLowerCase()}`, amount: asset.automationBalance,
              threshold: policies.find(policy => sameAddress(policy.address, asset.address))!.minimumRaw }));
            for (const asset of status.assets) readings.push({ key: `8453:collector:${asset.address.toLowerCase()}`, amount: String(integer(asset.pending, true) + integer(asset.untracked ?? "0", true) + integer(asset.pendingUntracked ?? "0", true)), threshold: policies.find(policy => sameAddress(policy.address, asset.address))!.minimumRaw });
            readings.push({ key: `4663:${BASE_BUYBACK_RH_WETH.toLowerCase()}`, amount: String(treasury), threshold: BASE_RECOVERY_FIXED_ASSETS.find(asset => sameAddress(asset.address, BASE_BUYBACK_WETH))!.minimumRaw });
            const changed = updateBaseStuckMonitor(observations, readings, observedAt);
            for (const alert of changed.alerts) await appendFundAlert(alertPath, { at: new Date(observedAt).toISOString(), state: "funds_stuck", ...alert });
            // Idle monitoring reuses a real retained reservation; it never
            // manufactures a task, fee quote or archive scan for an alert.
            const retainedJournal = execute ? journal : await readBasePublicJson<BaseKeeperJournal>(path);
            const history = retainedJournal && sameAddress(retainedJournal.collector, collector) && sameAddress(retainedJournal.keeper, keeper)
              ? unionBatches(retainedJournal.batches, current) : current;
            const typical = history.filter(row => row.journal && sameAddress(row.journal.caller, keeper) && !isBaseUntrackedTask(row) && row.gasReservation)
              .sort((a,b) => b.journal!.signedAt - a.journal!.signedAt)[0]?.gasReservation;
            let cachedReservation = false;
            if (!typical) try {
              const cached = await readBasePublicJson<Record<string, unknown>>(`${alertPath}.balance.json`);
              cachedReservation = !!cached && cached.version === 1 && cached.chainId === 8453 && typeof cached.keeper === "string" && sameAddress(cached.keeper, keeper) &&
                typeof cached.low === "boolean" && Number.isSafeInteger(cached.updatedAt) && Number(cached.updatedAt) >= 0 &&
                typeof cached.typicalReservationWei === "string" && /^[1-9]\d{0,77}$/.test(cached.typicalReservationWei) && integer(cached.typicalReservationWei) > 0n;
            } catch { console.log(JSON.stringify({mode:"monitor_pending",reason:"Private balance reservation cache is unavailable; financial execution is unchanged."})); }
            if (typical || cachedReservation) await monitorKeeperBalance({ path: alertPath, chainId: 8453, keeper,
              balanceWei: await client.getBalance({ address: keeper, blockTag: "latest" }), typicalReservationWei: typical ? integer(typical.totalWei, true) : 0n, now: observedAt });
            await writeBasePublicJson(observationPath, changed.state);
            observations = changed.state;
          } catch (error) { console.log(JSON.stringify({ mode: "monitor_pending", reason: redact(error, runtime.environment) })); }
        }
        if (execute) for (const resolved of await reconcileBaseKeeperHistory(journal, current, client, graph.runtimeHash,
          replacementHint ? [replacementHint[1], replacementHint[2] as Hex] : undefined)) { await persistLocal(resolved); await persistPublic(resolved); }
        const seed = (kind: BaseFeeBatch["kind"]): BaseFeeBatch => ({ id: `base-native-${randomUUID()}`, protocol: BASE_BUYBACK_PROTOCOL, sourceChainId: 8453, destinationChainId: 4663,
          collector, kind, status: "unknown", createdAt: observedAt, updatedAt: observedAt, amountIn: "0", receivedAmount: "0", refundedAmount: "0", burnedAmount: "0", claimHashes: [] });
        const policyFor = (address: Address) => policies.find(policy => sameAddress(policy.address, address));
        const tasks: BaseFeeBatch[] = [];
        for (const asset of status.assets) if (asset.verifiedAsset && integer(asset.pending, true) > 0n && policyFor(asset.address))
          tasks.push({ ...seed("release"), inputAsset: feeAsset(policyFor(asset.address)!), amountIn: asset.pending, release: { token: asset.address, amount: asset.pending, automation: graph.automationReceiver } });
        const recoveryContext = { policies, history: current, keeper, now: observedAt };
        if (untrackedCap > 0n) tasks.push(...baseUntrackedRecoveryTasks(status, kind => seed(kind), recoveryContext));
        const claims = new Map<string, { token: TokenRecord; asset: BaseRecoveryAssetPolicy }>();
        for (const claim of round.claims) { const task = { ...seed("claim"), poolId: claim.token.poolId, inputAsset: feeAsset(claim.asset) }; tasks.push(task); claims.set(task.id, claim); }
        if (tokens.length) { observations.poolCursor = round.poolCursor; await writeBasePublicJson(observationPath, observations); }
        const ordered = sortBaseKeeperTasks(tasks);
        console.log(JSON.stringify({ mode: execute ? "execute" : "audit_only", chainId: 8453, startupVerified: true,
          tasks: ordered.map(task => ({ kind: task.kind, poolId: task.poolId, asset: task.inputAsset?.address, amount: task.amountIn })) }));
        if (execute && account && !stopping) {
          const wallet = createWalletClient({ account, chain: base, transport: alchemyRpcTransport(8453, runtime.environment ?? {}, { metrics }) });
          for (const task of ordered) {
            if (stopping) break;
            if (baseTaskIsolated(task, unionBatches(journal.batches, current), account.address)) { deferred("This asset's submitted evidence is isolated", task); continue; }
            try {
              const prepared = await prepareBaseFeeTask(task, client, account.address, observedAt); if (!prepared) { deferred("Task simulation or gas reserve unavailable", task); continue; }
              const transaction = baseFeeTransaction(prepared), nonce = prepared.journal!.nonce, gas = BigInt(prepared.journal!.gasLimit), maxFeePerGas = BigInt(prepared.journal!.maxFeePerGas), reservation = prepared.gasReservation!;
              const gate = async (alreadyReserved = false) => {
                unlock!.assertHeld(); if (stopping) throw new Error("Keeper stopped before transport");
                const attempt = baseKeeperAttemptWait(reservation,account.address);
                if (attempt) throw new Error(`${attempt.reason}; nextAttemptAt=${attempt.nextAttemptAt}`);
                await assertBaseKeeperLiveAuthority(client, BASE_COLLECTOR_MANIFEST, account.address);
                assertBaseKeeperRoles(account.address, BASE_COLLECTOR_MANIFEST, runtime.config.treasury);
                await assertBaseOperationalControl(source, runtime, collector);
                assertBaseNoUnknown(unionBatches(journal.batches, await allBaseFeeBatches(source), true).filter(row => row.id !== prepared.id), account.address);
                if (prepared.kind === "release" || prepared.kind === "release_untracked") await assertBaseSelectedReleaseReadiness(client, prepared);
                const budgetJournal = alreadyReserved ? { ...journal, batches: journal.batches.filter(row => row.id !== prepared.id) } : journal;
                const balance = await client.getBalance({ address: account.address, blockTag: "latest" });
                await monitorKeeperBalance({ path: alertPath, chainId: 8453, keeper: account.address, balanceWei: balance,
                  typicalReservationWei: BigInt(reservation.totalWei), now: Date.now() });
                if (isBaseUntrackedTask(prepared)) {
                  if (!await assertCanonicalBaseUntrackedBudget(budgetJournal, prepared, source, untrackedCap)) throw new Error("Independent unknown gas budget exhausted");
                  if (!baseUntrackedWalletHasReserve(balance, reservation.totalWei)) throw new Error("Unknown recovery cannot consume genuine fee gas");
                  const policy = policyFor(prepared.inputAsset!.address)!;
                  const liveAmount = await client.readContract({ address: collector, abi: baseCollectorAbi, functionName: prepared.kind === "release_untracked" ? "pendingUntracked" : "untrackedBalance", args: [policy.address] });
                  if (typeof liveAmount !== "bigint" || liveAmount < integer(policy.minimumRaw) || baseUntrackedAssetCooling(policy.address,
                    prepared.kind === "release_untracked" ? "release_untracked" : "sync_untracked", { ...recoveryContext, history: unionBatches(budgetJournal.batches, current), now: Date.now() })) throw new Error("Unknown recovery minimum or cooldown no longer qualifies");
                } else {
                  if (balance < integer(reservation.totalWei, true)) throw new Error("Keeper wallet cannot fund this task's gas reserve");
                  await assertCanonicalBaseTaskGasPolicy(budgetJournal, prepared, source);
                }
                if (prepared.kind === "claim") {
                  const claim = claims.get(task.id)!;
                  const amount = await pendingPairedFees(sdk, claim.token, collector);
                  const minimum = await baseClaimValueWeth(quotes, claim.asset, amount, graph!.automationReceiver);
                  if (!baseClaimCoversGas(minimum, reservation)) throw new Error("Claim paired-fee value does not exceed the reserved gas");
                }
                await assertBaseGasReservationCurrent(client, transaction, nonce, gas, maxFeePerGas, reservation);
                unlock!.assertHeld();
              };
              const submitted = await submitBaseFeeBatch(prepared, { sign: async () => { await gate(); return wallet.signTransaction({ ...transaction, nonce, gas, maxFeePerGas, maxPriorityFeePerGas: 1n, type: "eip1559" }); },
                persistLocal, persistPublic, beforeBroadcast: () => gate(true), broadcast: raw => wallet.sendRawTransaction({ serializedTransaction: raw }) });
              if (submitted.status === "abandoned") { deferred("Signature abandoned before broadcast", prepared); continue; }
              await client.waitForTransactionReceipt({ hash: submitted.sourceHash!, confirmations: 2, timeout: 30000, pollingInterval: 1000 }).catch(() => undefined);
              const resolved = await reconcileBaseFeeBatch(submitted, client, undefined, graph.runtimeHash); await persistLocal(resolved); await persistPublic(resolved);
              assertBaseNoUnknown([resolved], account.address);
            } catch (error) { if (error instanceof BaseProcessLeaseLostError) throw error; deferred(error, task); }
          }
        }
      } catch (error) { if (error instanceof BaseProcessLeaseLostError) throw error; deferred(error); }
      finally { console.log(JSON.stringify({ mode: "keeper_rpc_metrics", chainId: 8453, observedAt, ...metrics.snapshot() })); }
      if (args.includes("--once") || stopping) break;
      await new Promise<void>(done => { const timer = setTimeout(() => { wake = undefined; done(); }, interval); wake = () => { clearTimeout(timer); wake = undefined; done(); }; if (stopping) wake(); });
    } while (!stopping);
  } finally { await unlock?.(); await source.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runBaseBuybackKeeper().catch(error => { console.error(redact(error)); process.exitCode = 1; });
