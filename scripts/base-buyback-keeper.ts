import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, parseAbi, http, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction,
  type Address, type Hex, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, robinhood } from "viem/chains";
import { BASE_BUYBACK_PROTOCOL, baseCollectorAbi, integer, type BaseFeeBatch, type BaseGasReservation } from "../src/lib/base-buyback";
import { CONTRACTS, sameAddress, type RuntimeConfig } from "../src/lib/config";
import { BASE_AUTOMATION_FEE_POLICY } from "../src/lib/fee-policy";
import type { VaultLedgerReport } from "../src/lib/buyback-vault-ledger";
import { BASE_COLLECTOR_MANIFEST, verifyBaseCollector, type BaseCollectorCanaryAuthorization } from "../server/base-collector";
import { BASE_GAS_PRICE_ORACLE, baseGasPriceOracleAbi, canonicalBaseReceipt, collectorClaimEvidence, collectorReleaseEvidence, readCanonicalBaseTransactionFee } from "../server/base-buyback";
import { loadEnvironment, redact, runtimeFromEnv, mainnetRpcUrl, type Runtime, type RuntimeEnvironment } from "../server/config";
import { SupabaseStore, type StoreBackend } from "../server/supabase-store";
import { LaunchpadService } from "../server/service";
import { assertNativeCustodyReadiness, type NativeCustodyReadiness } from "../server/buyback-vault-runtime";
import { acquireKeeperJournalLock, assertKeeperNonceReady, keeperApiOrigin } from "./buyback-keeper";

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
  const found: BaseFeeBatch[] = []; const cursors = new Set<string>(); let before: { updatedAt: number; id: string } | undefined;
  for (;;) {
    const page = await store.buybackBatchPage(100, before);
    found.push(...page.filter(row => row.protocol === BASE_BUYBACK_PROTOCOL) as unknown as BaseFeeBatch[]);
    if (page.length < 100) break;
    const tail = page.at(-1)!; before = { id: tail.id, updatedAt: tail.updatedAt };
    const key = JSON.stringify(before); if (cursors.has(key)) throw new Error("Base history pagination did not advance"); cursors.add(key);
  }
  return found;
}
export function assertBaseNoUnknown(batches: BaseFeeBatch[]) {
  if (batches.some(batch => ["unknown", "broadcast", "reorg"].includes(batch.status))) throw new Error("Base source transactions have unresolved outcomes; new spending is stopped");
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
export function baseFeeTransaction(batch: BaseFeeBatch) {
  if (batch.protocol !== BASE_BUYBACK_PROTOCOL || batch.sourceChainId !== 8453 || batch.destinationChainId !== 4663) throw new Error("Only native Base fee tasks can be signed");
  if (batch.kind === "claim" && batch.poolId && /^0x[\da-f]{64}$/i.test(batch.poolId)) return { to: batch.collector, value: 0n,
    data: encodeFunctionData({ abi: baseCollectorAbi, functionName: "claimFees", args: [batch.poolId] }) };
  if (batch.kind === "release" && batch.release && sameAddress(batch.release.token, batch.inputAsset?.address ?? "") && batch.release.amount === batch.amountIn)
    return { to: batch.collector, value: 0n, data: encodeFunctionData({ abi: baseCollectorAbi, functionName: "releaseFees", args: [batch.release.token, integer(batch.release.amount)] }) };
  throw new Error("Native Automation performs all swaps and bridges; the local keeper signs only exact claims or releases");
}
export async function submitBaseFeeBatch(batch: BaseFeeBatch, deps: {
  sign(): Promise<Hex>; persistLocal(batch: BaseFeeBatch): Promise<void>; persistPublic(batch: BaseFeeBatch): Promise<void>;
  broadcast(raw: Hex): Promise<Hex>; beforeBroadcast?(batch: BaseFeeBatch): Promise<void>;
}): Promise<BaseFeeBatch> {
  const request = baseFeeTransaction(batch), journal = batch.journal;
  if (!journal || !sameAddress(journal.to, request.to) || journal.dataHash !== keccak256(request.data)) throw new Error("The fee journal does not bind the fixed adapter action");
  const raw = await deps.sign(), parsed = parseTransaction(raw);
  if (parsed.type !== "eip1559" || parsed.chainId !== 8453 || !parsed.to || !sameAddress(parsed.to, request.to) || parsed.data !== request.data ||
    (parsed.value ?? 0n) !== 0n || parsed.nonce !== journal.nonce || parsed.gas !== BigInt(journal.gasLimit) || parsed.maxFeePerGas !== BigInt(journal.maxFeePerGas) ||
    parsed.maxPriorityFeePerGas !== 1n || parsed.accessList?.length || !batch.gasReservation ||
    !sameAddress(await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] }), journal.caller)) throw new Error("The signed transaction differs from the fixed Base task");
  let next: BaseFeeBatch = { ...batch, sourceHash: keccak256(raw), status: "unknown", updatedAt: Date.now(), journal: { ...journal, hash: keccak256(raw), signedAt: Date.now() } };
  const persist = async () => { await deps.persistLocal(next); await deps.persistPublic(next); };
  await persist(); // The public hash and gas reservation reach durable storage before submission.
  try {
    await deps.beforeBroadcast?.(next);
    const submitted = await deps.broadcast(raw); if (submitted.toLowerCase() !== next.sourceHash!.toLowerCase()) throw new Error("Provider returned another transaction hash");
    next = { ...next, status: "broadcast", updatedAt: Date.now() }; await persist(); return next;
  } catch {
    next = { ...next, status: "unknown", updatedAt: Date.now(), error: "Submission outcome unresolved; inspect the retained hash before any new source spending." };
    await persist(); throw new Error(next.error);
  }
}
const claimOutcomeAbi = parseAbi([
  "event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)",
  "event ClaimFailed(bytes32 indexed poolId,address indexed manager,bytes reason)",
]);
async function claimOutcome(receipt: Awaited<ReturnType<typeof canonicalBaseReceipt>>, batch: BaseFeeBatch, client: Client, expectedRuntimeHash?: Hex | null) {
  const managers = [CONTRACTS.initializer, CONTRACTS.rehype];
  const income = [], failed = new Set<string>();
  for (const log of receipt.logs.filter(log => sameAddress(log.address, batch.collector))) {
    const event = decodeEventLog({ abi: claimOutcomeAbi, topics: log.topics, data: log.data, strict: true });
    if (event.args.poolId !== batch.poolId || !managers.some(manager => sameAddress(manager, event.args.manager))) throw new Error("Unsupported claim manager or pool log");
    if (event.eventName === "FeesClaimed") income.push(event.args);
    else { if (failed.has(event.args.manager.toLowerCase())) throw new Error("Duplicate failed manager log"); failed.add(event.args.manager.toLowerCase()); }
  }
  if (!income.length) throw new Error("Canonical claim receipt lacks required manager delta logs");
  if (income.some(row => row.amount > 0n)) return collectorClaimEvidence(receipt, batch.collector, batch.poolId!);
  // _credit always emits both actual deltas, including zero. A raced claim is
  // resolved only with the exact runtime and complete, recognized manager pairs.
  if (!expectedRuntimeHash) throw new Error("Zero-credit claim lacks the reviewed runtime identity");
  const code = await client.getCode({ address: batch.collector, blockNumber: receipt.blockNumber });
  if (!code || code === "0x" || keccak256(code) !== expectedRuntimeHash) throw new Error("Zero-credit claim runtime differs");
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
  return [];
}
export async function reconcileBaseFeeBatch(batch: BaseFeeBatch, client: Client, replacement?: Hex,
  expectedRuntimeHash = BASE_COLLECTOR_MANIFEST.collector.runtimeHash): Promise<BaseFeeBatch> {
  if (!batch.sourceHash || !batch.journal) return batch;
  const hash = replacement ?? batch.sourceHash;
  try {
    const receipt = await canonicalBaseReceipt(client, hash, 8453), tx = await client.getTransaction({ hash });
    if (tx.hash !== hash || receipt.transactionHash !== hash || !sameAddress(tx.from, batch.journal.caller) || tx.nonce !== batch.journal.nonce || tx.value !== 0n) throw new Error("Canonical transaction identity changed");
    const cancellation = !!replacement && tx.to && sameAddress(tx.to, tx.from) && tx.input === "0x";
    if (cancellation) {
      if (receipt.status !== "success" || receipt.logs.length || !["legacy", "eip1559", "eip2930"].includes(tx.type) || (tx as any).authorizationList?.length ||
        [await client.getCode({ address: tx.from, blockNumber: receipt.blockNumber }), await client.getCode({ address: tx.from, blockNumber: receipt.blockNumber - 1n })].some(code => !!code && code !== "0x")) throw new Error("Delegation or execution cannot prove an empty cancellation");
    } else {
      const request = baseFeeTransaction(batch);
      if (!tx.to || !sameAddress(tx.to, request.to) || tx.input !== request.data || keccak256(tx.input) !== batch.journal.dataHash) throw new Error("Replacement changed the fixed action");
    }
    const actualGas = await readCanonicalBaseTransactionFee(client, receipt);
    const next: BaseFeeBatch = { ...batch, sourceHash: hash, sourceBlockNumber: String(receipt.blockNumber), sourceBlockHash: receipt.blockHash,
      actualGas, updatedAt: Date.now(), error: undefined, status: cancellation ? "cancelled" : receipt.status === "reverted" ? "reverted" : batch.kind === "claim" ? "claimed" : "released" };
    if (!cancellation && receipt.status === "success") {
      if (batch.kind === "claim") { next.claimCredits = await claimOutcome(receipt, batch, client, expectedRuntimeHash); next.claimHashes = [hash]; }
      else next.release = collectorReleaseEvidence(receipt, batch.collector, batch.release!.token, batch.release!.amount, batch.release!.automation);
    }
    if (replacement) next.replacements = [...(batch.replacements ?? []).filter(row => row.hash !== hash), { hash, cancelled: !!cancellation, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash }];
    return next;
  } catch { return { ...batch, status: batch.sourceBlockHash ? "reorg" : "unknown", error: "Source transaction or fee evidence remains unresolved.", updatedAt: Date.now() }; }
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
function unionBatches(local: BaseFeeBatch[], canonical: BaseFeeBatch[]) {
  const merged = new Map(canonical.map(batch => [batch.id, batch]));
  for (const batch of local) { const other = merged.get(batch.id); if (!other || batch.updatedAt > other.updatedAt) merged.set(batch.id, batch); }
  return [...merged.values()];
}
export async function assertCanonicalBaseCanaryBudget(journal: BaseKeeperJournal, next: BaseFeeBatch, store: Pick<StoreBackend, "buybackBatchPage">,
  client: Client, maxGas: bigint, authorization?: BaseCollectorCanaryAuthorization) {
  const all = unionBatches(journal.batches, await allBaseFeeBatches(store)).filter(batch => batch.id !== next.id);
  let gas = 0n; const nonces = new Map<string,bigint>();
  for (const batch of all) if (batch.journal && sameAddress(batch.journal.caller, journal.keeper)) {
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
  if (!next.gasReservation || gas + integer(next.gasReservation.totalWei, true) > maxGas) throw new Error("The cumulative canonical Base gas budget is exhausted");
  if (authorization) {
    if (!sameAddress(authorization.keeper, journal.keeper)) throw new Error("The owner authorized a different canary keeper");
    if (next.kind === "release") {
      const budget = authorization.releaseBudgets.find(row => sameAddress(row.token, next.release!.token));
      if (!budget || budget.decimals !== next.inputAsset?.decimals) throw new Error("The owner did not authorize this canary release asset precision");
      const released = await client.readContract({ address: next.collector, abi: baseCollectorAbi, functionName: "totalReleased", args: [budget.token] });
      const claimed = await client.readContract({ address: next.collector, abi: baseCollectorAbi, functionName: "totalClaimed", args: [budget.token] });
      const reserved = all.filter(batch => batch.kind === "release" && batch.release && sameAddress(batch.release.token, budget.token) && ["unknown", "broadcast", "reorg"].includes(batch.status))
        .reduce((sum, batch) => sum + integer(batch.amountIn), 0n);
      if (released + reserved + integer(next.amountIn) > integer(budget.maxAmount) || released + integer(next.amountIn) > claimed) throw new Error("The cumulative canary token release ceiling or genuine fee income is exceeded");
    }
  }
}
async function apiRead<T>(origin: string, path: string): Promise<T> {
  const response = await fetch(`${origin}/api/chains/8453${path}`, { signal: AbortSignal.timeout(20000), headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error("Chain-scoped Base readiness read failed"); return response.json() as Promise<T>;
}
export async function runBaseBuybackKeeper(args = process.argv.slice(2)) {
  const execute = args.includes("--execute");
  if (args.some(arg => !["--execute", "--once", "--help"].includes(arg) && !/^--(?:api|interval|max-gas-wei|replacement)=/.test(arg))) throw new Error("Unsupported Base keeper option");
  for (const name of ["api", "interval", "max-gas-wei", "replacement"]) if (args.filter(arg => arg.startsWith(`--${name}=`)).length > 1) throw new Error(`Select only one --${name} value`);
  if (args.includes("--help")) { console.log("Base native fee keeper: [--once] [--api=https://musegod.fun] [--interval=30000]. --execute requires --max-gas-wei, an isolated key process, canonical Supabase journals and owner canary authorization. No swap or bridge signing. --replacement=<batchId>:<hash> is a canonical same-nonce reconciliation hint only."); return; }
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
  const hint = args.find(arg => arg.startsWith("--replacement="))?.slice(14);
  const replacementHint = hint?.match(/^([^:]{1,200}):(0x[\da-f]{64})$/i);
  if (hint && (!execute || !replacementHint)) throw new Error("A replacement hint requires --execute and the exact batchId:transactionHash");
  const runtime = runtimeFromEnv(undefined, { ...process.env, CHAIN_MODE: "base" });
  const canary = runtime.dataScope === "verify-base-canary"; if (canary) assertBaseCanaryStorage(runtime);
  (runtime as Runtime & {canaryOrigin?: string}).canaryOrigin = canary ? origin : undefined;
  const source = baseSourceStore(runtime), service = new LaunchpadService(runtime), collector = BASE_COLLECTOR_MANIFEST.collector.address;
  const client = createPublicClient({ chain: base, transport: http(runtime.rpcUrl, { timeout: 30000, retryCount: 0 }) });
  const destination = createPublicClient({ chain: robinhood, transport: http(mainnetRpcUrl(4663, runtime.environment), { timeout: 30000, retryCount: 0 }) });
  const account = execute ? privateKeyToAccount(process.env.MUSEGOD_KEEPER_PRIVATE_KEY as Hex) : null;
  const path = account ? baseCanonicalKeeperLease(collector, account.address) : null;
  const unlock = path ? await acquireKeeperJournalLock(path) : null;
  let journal: BaseKeeperJournal = { version: 2, collector, keeper: account?.address ?? "0x0000000000000000000000000000000000000001", batches: [] };
  let stopping = false; process.once("SIGINT", () => { stopping = true; }); process.once("SIGTERM", () => { stopping = true; });
  try {
    if (path) journal = await readBasePublicJson<BaseKeeperJournal>(path) ?? journal;
    if (journal.version !== 2 || !sameAddress(journal.collector, collector) || !sameAddress(journal.keeper, account?.address ?? journal.keeper) || !Array.isArray(journal.batches)) throw new Error("The canonical native keeper journal identity differs");
    do {
      const graph = await verifyBaseCollector(client, collector, { requireActivation: execute && !canary, allowCanary: execute && canary, canaryOrigin: canary ? origin : undefined, robinhoodClient: destination });
      const config = await service.config(), all = unionBatches(journal.batches, await allBaseFeeBatches(source));
      const persistLocal = async (batch: BaseFeeBatch) => { journal.batches = unionBatches([batch], journal.batches); if (path) await writeBasePublicJson(path, journal); };
      const persistPublic = async (batch: BaseFeeBatch) => { await source.saveBuybackBatch(batch); };
      if (replacementHint && !all.some(batch => batch.id === replacementHint[1] && batch.journal && sameAddress(batch.journal.caller, account!.address))) throw new Error("The replacement hint does not identify this keeper’s retained native task");
      if (execute) for (const prior of all.filter(batch => batch.journal && sameAddress(batch.journal.caller, account!.address) && batch.sourceHash)) {
        const replacement = replacementHint?.[1] === prior.id ? replacementHint[2] as Hex : undefined;
        const resolved = await reconcileBaseFeeBatch(prior, client, replacement, graph.runtimeHash); await persistLocal(resolved); await persistPublic(resolved);
      }
      const current = unionBatches(journal.batches, await allBaseFeeBatches(source));
      if (execute) { assertBaseNoUnknown(current); await assertBaseOperationalControl(service.store, { config }, collector); }
      const tasks: BaseFeeBatch[] = [], now = Date.now();
      const seed = (kind: "claim" | "release"): BaseFeeBatch => ({ id: `base-native-${randomUUID()}`, protocol: BASE_BUYBACK_PROTOCOL, sourceChainId: 8453, destinationChainId: 4663,
        collector, kind, status: "unknown", createdAt: now, updatedAt: now, amountIn: "0", receivedAmount: "0", refundedAmount: "0", burnedAmount: "0", claimHashes: [] });
      for (const token of await service.store.tokens()) if (token.feePolicy === BASE_AUTOMATION_FEE_POLICY && token.feeEngine && sameAddress(token.feeEngine, collector)) {
        const fees = await service.fees(token.address, collector);
        if ([fees.lp.fees0, fees.lp.fees1, fees.trade.fees0, fees.trade.fees1].some(value => value > 0n)) tasks.push({ ...seed("claim"), poolId: token.poolId });
      }
      const status = await apiRead<import("../src/lib/base-buyback").BaseCollectorStatus>(origin, "/buyback/engine");
      if (status.available && sameAddress(status.collector ?? "", collector) && status.automation && sameAddress(status.automation, graph.automationReceiver))
        for (const asset of status.assets) if (integer(asset.pending, true) > 0n) tasks.push({ ...seed("release"), inputAsset: asset, amountIn: asset.pending,
          release: { token: asset.address, amount: asset.pending, automation: graph.automationReceiver } });
      console.log(JSON.stringify({ mode: execute ? "execute" : "dry_run", chainId: 8453, tasks: tasks.map(task => ({ kind: task.kind, poolId: task.poolId, asset: task.inputAsset?.address, amount: task.amountIn })) }));
      if (execute && account) {
        const wallet = createWalletClient({ account, chain: base, transport: http(runtime.rpcUrl, { timeout: 30000, retryCount: 0 }) });
        for (const task of tasks) {
          const transaction = baseFeeTransaction(task);
          const [latest, pending] = await Promise.all([client.getTransactionCount({ address: account.address, blockTag: "latest" }), client.getTransactionCount({ address: account.address, blockTag: "pending" })]);
          assertKeeperNonceReady(latest, pending);
          await client.call({ ...transaction, account: account.address });
          const estimate = await client.estimateGas({ ...transaction, account: account.address }), gas = (estimate * 125n + 99n) / 100n;
          const fees = await client.estimateFeesPerGas(); if (!fees.maxFeePerGas) throw new Error("Base max fee unavailable");
          const reservation = await reserveBaseGas(client, transaction, latest, gas, fees.maxFeePerGas);
          const prepared: BaseFeeBatch = { ...task, gasReservation: reservation, journal: { caller: account.address, nonce: latest, to: collector, dataHash: keccak256(transaction.data), hash: `0x${"00".repeat(32)}`, gasLimit: String(gas), maxFeePerGas: String(fees.maxFeePerGas), signedAt: now } };
          const gate = async (alreadyReserved = false) => {
            const fresh = await verifyBaseCollector(client, collector, { requireActivation: !canary, allowCanary: canary, canaryOrigin: canary ? origin : undefined, robinhoodClient: destination });
            if (fresh.manifestFingerprint !== graph.manifestFingerprint || fresh.paused || !sameAddress(fresh.automationReceiver, graph.automationReceiver)) throw new Error("The native fee graph changed or paused");
            await assertBaseOperationalControl(service.store, { config: await service.config() }, collector);
            await assertBaseVaultCheckpoint(() => apiRead<VaultLedgerReport>(origin, "/buyback/vault-ledger"));
            assertBaseNoUnknown((await allBaseFeeBatches(source)).filter(row => row.id !== prepared.id));
            assertNativeCustodyReadiness(await apiRead<NativeCustodyReadiness>(origin, "/buyback/custody"));
            if (task.kind === "release") {
              const readiness = await apiRead<{ available: boolean; nativeAutomationState: string; ledgerComplete: boolean }>(origin, "/buyback/engine");
              if (!readiness.available || readiness.nativeAutomationState !== "configured" || !readiness.ledgerComplete) throw new Error("Native Automation authorization and custody checkpoints are not verified");
            }
            await assertBaseGasReservationCurrent(client, transaction, latest, gas, fees.maxFeePerGas!, reservation);
            if (await client.getBalance({ address: account.address, blockTag: "latest" }) < BigInt(reservation.totalWei)) throw new Error("The keeper lacks the reserved Base gas; fund the reviewed keeper before submitting");
            const cap = fresh.canaryAuthorization ? BigInt(fresh.canaryAuthorization.maxBaseGasWei) < BigInt(rawCap!) ? BigInt(fresh.canaryAuthorization.maxBaseGasWei) : BigInt(rawCap!) : BigInt(rawCap!);
            // The new task is already included in durable source history before broadcast.
            const budgetJournal = alreadyReserved ? { ...journal, batches: journal.batches.filter(row => row.id !== prepared.id) } : journal;
            await assertCanonicalBaseCanaryBudget(budgetJournal, prepared, source, client, cap, fresh.canaryAuthorization);
          };
          await gate();
          const submitted = await submitBaseFeeBatch(prepared, { sign: async () => { await gate(); return wallet.signTransaction({ ...transaction, nonce: latest, gas, maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: 1n, type: "eip1559" }); },
            persistLocal, persistPublic, beforeBroadcast: async () => gate(true), broadcast: raw => wallet.sendRawTransaction({ serializedTransaction: raw }) });
          await client.waitForTransactionReceipt({ hash: submitted.sourceHash!, confirmations: 2, timeout: 30000, pollingInterval: 1000 }).catch(() => undefined);
          const resolved = await reconcileBaseFeeBatch(submitted, client, undefined, graph.runtimeHash); await persistLocal(resolved); await persistPublic(resolved); assertBaseNoUnknown([resolved]);
        }
      }
      if (!args.includes("--once") && !stopping) await new Promise(resolve => setTimeout(resolve, interval));
    } while (!args.includes("--once") && !stopping);
  } finally { await unlock?.(); await source.close(); await service.store.close(); await service.vaultLedgerRuntime?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runBaseBuybackKeeper().catch(error => { console.error(redact(error)); process.exitCode = 1; });
