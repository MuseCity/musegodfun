// Keeper-host only. This adapter never requests a remote debug method and never
// substitutes a partial replay for a canonical funds-provenance proof.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isAddress, keccak256, stringToHex, type Address, type Hex, type PublicClient, type Transport } from "viem";
import type { BaseAuditStore } from "../server/base-audit";
import { BUYBACK_CODE_HASHES } from "../server/buyback";

export const LOCAL_REPLAY_CAST = Object.freeze({ version: "1.8.5", commit: "51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f",
  executable: "cast-musegod-base-1.8.5",
  // The reviewed macOS host binary. A different build needs its own review;
  // accepting a self-reported version alone would not bind executable code.
  sha256: "d2e3050c71d7e0a5f359c81f17c13a8e5a96f481e4b59c78309ecd114a668064" });
const MAX_NODES = 4096, MAX_DEPTH = 128, MAX_BYTES = 8 * 1024 * 1024, MAX_TRANSACTIONS = 2048, MAX_LOGS = 16_384;
export type LocalReplayPendingCode = "configuration" | "invalid_request" | "wrong_chain" | "missing_history" | "noncanonical"
  | "transaction_binding" | "unsupported_transaction" | "unsupported_l2_prefix" | "unsupported_arena" | "resource_limit"
  | "receipt_mismatch" | "changed_code" | "unsupported_vm" | "rpc_unavailable" | "timeout"
  | "engine_unavailable" | "unreviewed_engine" | "replay_failed" | "cache_unavailable" | "cache_busy" | "retry_backoff";
export class LocalReplayPendingError extends Error {
  constructor(readonly code: LocalReplayPendingCode) { super(`Local replay pending: ${code}`); this.name = "LocalReplayPendingError"; }
}
const pending = (code: LocalReplayPendingCode): never => { throw new LocalReplayPendingError(code); };
const requireFact = (ok: unknown, code: LocalReplayPendingCode): void => { if (!ok) pending(code); };
const object = (v: unknown): Record<string, any> => {
  requireFact(!!v && typeof v === "object" && !Array.isArray(v), "unsupported_arena"); return v as Record<string, any>;
};
const hash = (v: unknown): v is Hex => typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const bytes = (v: unknown): v is Hex => typeof v === "string" && v.length <= MAX_BYTES * 2 + 2 && v.length % 2 === 0 && /^0x[\da-f]*$/i.test(v);
const address = (v: unknown): v is Address => typeof v === "string" && isAddress(v, { strict: false });
const same = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
function quantity(v: unknown, code: LocalReplayPendingCode = "unsupported_arena"): bigint {
  requireFact(typeof v === "string" && /^0x[\da-f]+$/i.test(v), code); return BigInt(v as string);
}
function index(v: unknown): number { requireFact(Number.isSafeInteger(v) && Number(v) >= 0, "unsupported_arena"); return Number(v); }
const hexQuantity = (v: number | bigint): Hex => `0x${BigInt(v).toString(16)}`;
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
const fingerprint = (v: unknown): Hex => keccak256(stringToHex(stable(v)));

export type LocalReplayTrace = { type: string; from: Address; to: Address; input: Hex; output: Hex; value: Hex;
  gas: Hex; gasUsed: Hex; error?: string; calls: LocalReplayTrace[] };
export type LocalReplayLog = { address: Address; topics: Hex[]; data: Hex };
/** Parse the complete raw arena, including failed subtrees. Delegate/CALLCODE
 * logs inherit the parent's storage context; child indices and ordering are
 * validated, never guessed from decoded labels or log positions. */
export function convertFoundryReplayArena(raw: unknown): { trace: LocalReplayTrace; logs: LocalReplayLog[]; nodeCount: number } {
  const arena = object(raw).arena;
  requireFact(Array.isArray(arena) && arena.length > 0, "unsupported_arena");
  requireFact(arena.length <= MAX_NODES, "resource_limit");
  const visited = new Set<number>(); let encodedBytes = 0, logCount = 0;
  const visit = (at: number, parent: number | null, context: Address | undefined, depth: number, reverted: boolean):
    { trace: LocalReplayTrace; logs: LocalReplayLog[] } => {
    requireFact(depth <= MAX_DEPTH, "resource_limit");
    requireFact(at < arena.length && !visited.has(at), "unsupported_arena"); visited.add(at);
    const node = object(arena[at]), t = object(node.trace);
    requireFact(node.idx === at && node.parent === parent && t.depth === depth && address(t.caller) && address(t.address) &&
      typeof t.success === "boolean" && typeof t.status === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(t.status), "unsupported_arena");
    requireFact(["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE", "CREATE", "CREATE2"].includes(t.kind) &&
      bytes(t.data) && bytes(t.output) && Array.isArray(node.children) && Array.isArray(node.logs) && Array.isArray(node.ordering) &&
      Array.isArray(t.steps) && t.steps.length === 0 && !t.selfdestruct_address && !t.selfdestruct_refund_target &&
      !t.selfdestruct_transferred_value, "unsupported_arena");
    requireFact(t.success ? ["Return", "Stop"].includes(t.status) : !["Return", "Stop"].includes(t.status), "unsupported_arena");
    logCount += node.logs.length; requireFact(logCount <= MAX_LOGS, "resource_limit");
    const value = quantity(t.value), gas = index(t.gas_limit), gasUsed = index(t.gas_used);
    encodedBytes += (t.data.length + t.output.length - 4) / 2; requireFact(encodedBytes <= MAX_BYTES, "resource_limit");
    const ownContext = ["DELEGATECALL", "CALLCODE"].includes(t.kind) ? context : t.address;
    requireFact(address(ownContext), "unsupported_arena");
    const trace: LocalReplayTrace = { type: t.kind, from: t.caller, to: t.address, input: t.data, output: t.output,
      value: hexQuantity(value), gas: hexQuantity(gas), gasUsed: hexQuantity(gasUsed), calls: [], ...(!t.success ? { error: t.status } : {}) };
    const failed = reverted || !t.success, logs: LocalReplayLog[] = [], seenCalls = new Set<number>(), seenLogs = new Set<number>();
    for (const entry of node.ordering) {
      const order = object(entry), keys = Object.keys(order); requireFact(keys.length === 1, "unsupported_arena");
      if (keys[0] === "Call") {
        const relative = index(order.Call); requireFact(relative < node.children.length && !seenCalls.has(relative) && relative === seenCalls.size, "unsupported_arena");
        seenCalls.add(relative); const child = visit(index(node.children[relative]), at, ownContext, depth + 1, failed);
        requireFact(same(child.trace.from, ownContext), "unsupported_arena"); trace.calls.push(child.trace); logs.push(...child.logs);
      } else if (keys[0] === "Log") {
        const relative = index(order.Log); requireFact(relative < node.logs.length && !seenLogs.has(relative) && relative === seenLogs.size, "unsupported_arena");
        seenLogs.add(relative); const log = object(node.logs[relative]), rawLog = object(log.raw_log);
        requireFact(index(log.position) === seenCalls.size && Array.isArray(rawLog.topics) && rawLog.topics.length <= 4 &&
          rawLog.topics.every(hash) && bytes(rawLog.data), "unsupported_arena");
        encodedBytes += (rawLog.data.length - 2) / 2 + 32 * rawLog.topics.length; requireFact(encodedBytes <= MAX_BYTES, "resource_limit");
        if (!failed) logs.push({ address: ownContext!, topics: rawLog.topics, data: rawLog.data });
      } else pending("unsupported_arena");
    }
    requireFact(seenCalls.size === node.children.length && seenLogs.size === node.logs.length, "unsupported_arena");
    return { trace, logs };
  };
  const result = visit(0, null, undefined, 0, false); requireFact(visited.size === arena.length, "unsupported_arena");
  return { ...result, nodeCount: arena.length };
}
function validateBaseReplayPrecompiles(raw: unknown): void {
  for (const node of object(raw).arena) {
    const frame = object(node).trace, target = BigInt(frame.address);
    // Reviewed ordinary Ethereum precompiles only. A native Base extension,
    // BLS or P256 call needs its own VM/receipt acceptance; never guess that
    // the shipped OP fallback implements every native Base extension.
    if (target <= 0xffffn || frame.maybe_precompile != null)
      requireFact(target >= 1n && target <= 10n, "unsupported_vm");
  }
}

export type LocalReplaySnapshot = { chainId: number; transaction: Record<string, any>; receipt: Record<string, any>;
  block: Record<string, any>; parentBlock: Record<string, any> };
function transactionShape(tx: Record<string, any>) {
  return { hash: tx.hash?.toLowerCase(), blockHash: tx.blockHash?.toLowerCase(), blockNumber: tx.blockNumber,
    transactionIndex: tx.transactionIndex, from: tx.from?.toLowerCase(), to: tx.to?.toLowerCase(), input: tx.input?.toLowerCase(),
    value: tx.value, type: tx.type, nonce: tx.nonce, gas: tx.gas, gasPrice: tx.gasPrice,
    maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, chainId: tx.chainId, accessList: tx.accessList,
    // These are execution inputs, not optional display annotations. In
    // particular an authorization can change code for a later transaction.
    authorizationList: tx.authorizationList, sourceHash: tx.sourceHash, mint: tx.mint, isSystemTx: tx.isSystemTx,
    maxFeePerBlobGas: tx.maxFeePerBlobGas, blobVersionedHashes: tx.blobVersionedHashes,
    r: tx.r, s: tx.s, v: tx.v, yParity: tx.yParity };
}
export function localReplayReceiptFingerprint(receipt: Record<string, any>): Hex {
  return fingerprint({ transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber,
    transactionIndex: receipt.transactionIndex, from: receipt.from, to: receipt.to, status: receipt.status, type: receipt.type,
    gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, gasUsedForL1: receipt.gasUsedForL1,
    l1Fee: receipt.l1Fee, logs: receipt.logs });
}
function snapshotBinding(s: LocalReplaySnapshot) {
  return fingerprint({ chainId: s.chainId, transaction: transactionShape(s.transaction), receipt: localReplayReceiptFingerprint(s.receipt),
    // Include the complete ordered block, not just the selected hash/prefix.
    block: { ...s.block, transactions: s.block.transactions.map(transactionShape) }, parentBlock: s.parentBlock });
}
export function validateLocalReplaySnapshot(s: LocalReplaySnapshot, chainId: 8453 | 4663, txHash: Hex): void {
  const { transaction: tx, receipt: r, block: b, parentBlock: p } = s;
  requireFact(tx && r && b && p, "missing_history");
  requireFact(s.chainId === chainId && (!tx.chainId || quantity(tx.chainId, "wrong_chain") === BigInt(chainId)), "wrong_chain");
  requireFact(hash(txHash) && same(tx.hash, txHash) && same(r.transactionHash, txHash) && hash(tx.blockHash) &&
    same(tx.blockHash, r.blockHash) && same(r.blockHash, b.hash) && hash(p.hash) && same(b.parentHash, p.hash) &&
    quantity(tx.blockNumber, "noncanonical") === quantity(r.blockNumber, "noncanonical") &&
    quantity(r.blockNumber, "noncanonical") === quantity(b.number, "noncanonical") &&
    quantity(p.number, "noncanonical") + 1n === quantity(b.number, "noncanonical"), "noncanonical");
  requireFact(address(tx.from) && address(tx.to) && same(tx.from, r.from) && same(tx.to, r.to) && bytes(tx.input) &&
    [0n, 1n].includes(quantity(r.status, "transaction_binding")) && Array.isArray(r.logs) && Array.isArray(b.transactions), "transaction_binding");
  const txIndex = Number(quantity(tx.transactionIndex, "transaction_binding"));
  requireFact(b.transactions.length <= MAX_TRANSACTIONS, "resource_limit");
  requireFact(Number.isSafeInteger(txIndex) && txIndex >= 0 && txIndex < b.transactions.length &&
    quantity(r.transactionIndex, "transaction_binding") === BigInt(txIndex), "transaction_binding");
  const txHashes = new Set<string>();
  b.transactions.forEach((other: Record<string, any>, i: number) => {
    requireFact(other && hash(other.hash) && !txHashes.has(other.hash.toLowerCase()) && same(other.blockHash, b.hash) &&
      quantity(other.blockNumber, "transaction_binding") === quantity(b.number) &&
      quantity(other.transactionIndex, "transaction_binding") === BigInt(i), "transaction_binding"); txHashes.add(other.hash.toLowerCase());
  });
  requireFact(fingerprint(transactionShape(b.transactions[txIndex])) === fingerprint(transactionShape(tx)), "transaction_binding");
  let previous = -1n;
  for (const log of r.logs) {
    requireFact(log && !log.removed && address(log.address) && Array.isArray(log.topics) && log.topics.every(hash) && bytes(log.data) &&
      same(log.transactionHash, txHash) && same(log.blockHash, b.hash) && quantity(log.blockNumber, "transaction_binding") === quantity(b.number) &&
      quantity(log.transactionIndex, "transaction_binding") === BigInt(txIndex) && quantity(log.logIndex, "transaction_binding") > previous, "transaction_binding");
    previous = quantity(log.logIndex);
  }
  // The digest-pinned 1.8.5 OP executor converts real deposit envelopes and
  // replays them only with --replay-system-txes. Nitro remains unsupported.
  // Unknown types must not be silently converted to ordinary EVM calls.
  for (const other of b.transactions.slice(0, txIndex)) {
    const type = quantity(other.type, "unsupported_l2_prefix");
    const deposit = chainId === 8453 && type === 0x7en;
    if (!(type <= 2n || chainId === 8453 && type === 4n || deposit) ||
      same(other.from, "0x00000000000000000000000000000000000a4b05") ||
      !deposit && same(other.from, "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001")) pending("unsupported_l2_prefix");
    requireFact(address(other.from) && bytes(other.input) && (!other.chainId || quantity(other.chainId, "wrong_chain") === BigInt(chainId)), "transaction_binding");
    if (deposit) requireFact(hash(other.sourceHash) && quantity(other.mint ?? "0x0", "transaction_binding") >= 0n &&
      (other.isSystemTx === undefined || typeof other.isSystemTx === "boolean"), "transaction_binding");
    if (type === 4n) requireFact(Array.isArray(other.authorizationList) && other.authorizationList.length > 0 && other.authorizationList.every((auth: any) =>
      auth && address(auth.address) && quantity(auth.chainId, "transaction_binding") >= 0n && quantity(auth.nonce, "transaction_binding") >= 0n &&
      quantity(auth.yParity, "transaction_binding") <= 1n && hash(auth.r) && hash(auth.s)), "transaction_binding");
  }
  requireFact(quantity(tx.type, "unsupported_transaction") <= 2n, "unsupported_transaction");
}
function validateResult(s: LocalReplaySnapshot, result: ReturnType<typeof convertFoundryReplayArena>): void {
  const { trace, logs } = result, tx = s.transaction, receipt = s.receipt;
  requireFact(trace.type === "CALL" && same(trace.from, tx.from) && same(trace.to, tx.to) && same(trace.input, tx.input) &&
    quantity(trace.value) === quantity(tx.value, "transaction_binding") && !!trace.error === (quantity(receipt.status) === 0n), "receipt_mismatch");
  const canonicalLogs = receipt.logs.map((l: Record<string, any>) => ({ address: l.address.toLowerCase(), topics: l.topics.map((t: string) => t.toLowerCase()), data: l.data.toLowerCase() }));
  const replayLogs = logs.map(l => ({ address: l.address.toLowerCase(), topics: l.topics.map(t => t.toLowerCase()), data: l.data.toLowerCase() }));
  requireFact(fingerprint(canonicalLogs) === fingerprint(replayLogs), "receipt_mismatch");
}
/** Offline call-tree/receipt comparison only. A replay's per-call gas is never
 * transaction cost: canonical receipt gas remains the separate budget proof. */
export function validateLocalReplayEvidence(s: LocalReplaySnapshot, arena: unknown, chainId: 8453 | 4663, txHash: Hex) {
  validateLocalReplaySnapshot(s, chainId, txHash); const converted = convertFoundryReplayArena(arena); validateResult(s, converted);
  if (chainId === 8453) { validateBaseReplayPrecompiles(arena); validateBaseReplayGas(s, arena); }
  return { ...converted, canonicalTransactionGasUsed: s.receipt.gasUsed as Hex, replayGasUsedForBudget: false as const };
}

/** A call-frame's gas_used omits transaction intrinsic gas and is before the
 * final refund. Compare the independently calculated net transaction cost;
 * never use a frame's gas as the keeper's budget cost. Targets are CALLs with
 * ordinary type 0/1/2; authorization transactions are supported as prefixes. */
function validateBaseReplayGas(s: LocalReplaySnapshot, raw: unknown): void {
  const root = object(object(raw).arena[0]).trace, tx = s.transaction;
  let intrinsic = 21_000n;
  for (let i = 2; i < tx.input.length; i += 2) intrinsic += tx.input.slice(i, i + 2) === "00" ? 4n : 16n;
  const accessList = tx.accessList ?? [];
  requireFact(Array.isArray(accessList) && accessList.length <= MAX_TRANSACTIONS, "transaction_binding");
  for (const entry of accessList) {
    requireFact(entry && address(entry.address) && Array.isArray(entry.storageKeys) && entry.storageKeys.length <= MAX_LOGS && entry.storageKeys.every(hash), "transaction_binding");
    intrinsic += 2400n + BigInt(entry.storageKeys.length) * 1900n;
  }
  const limit = BigInt(index(root.gas_limit)), used = BigInt(index(root.gas_used)), refund = BigInt(index(root.gas_refund_counter));
  requireFact(quantity(tx.gas, "transaction_binding") - limit === intrinsic && used <= limit, "receipt_mismatch");
  const spent = intrinsic + used, cappedRefund = refund < spent / 5n ? refund : spent / 5n;
  requireFact(root.success || refund === 0n, "receipt_mismatch");
  // A different transaction gas model, including an active calldata floor,
  // remains pending until reviewed; never infer a chain's fork from another
  // chain or subtract an unexplained difference from the canonical receipt.
  requireFact(quantity(s.receipt.gasUsed, "receipt_mismatch") === spent - cappedRefund, "receipt_mismatch");
}

export type LocalReplayOptions = { chainId: 8453 | 4663; rpcUrl: string; castPath?: string; timeoutMs?: number; auditStore?: BaseAuditStore | Pick<BaseAuditStore, "getBuybackBatch"> };
export type LocalReplayMetadata = { version: 2; chainId: 8453 | 4663; transactionHash: Hex; blockHash: Hex; blockNumber: string;
  transactionIndex: string; receiptFingerprint: Hex; inputHash: Hex; snapshotFingerprint: Hex; codeFingerprint: Hex;
  castVersion: string; castSha256: string; fullReplay: true; systemTransactionsReplayed: true; blockAccessListUsed: false;
  replayGasUsedForBudget: false };
function optionsDeadline(options: LocalReplayOptions): number {
  try { const url = new URL(options.rpcUrl); requireFact(["http:", "https:"].includes(url.protocol) && !url.username && !url.password, "configuration"); }
  catch { pending("configuration"); }
  requireFact([8453, 4663].includes(options.chainId) && (options.timeoutMs === undefined || Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs > 0 && options.timeoutMs <= 60_000), "configuration"); return Date.now() + (options.timeoutMs ?? 60_000);
}
async function bounded<T>(work: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now(); if (remaining <= 0) pending("timeout"); let timer: ReturnType<typeof setTimeout> | undefined;
  try { const value = await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LocalReplayPendingError("timeout")), remaining); })]);
    requireFact(Date.now() < deadline, "timeout"); return value;
  } finally { clearTimeout(timer); }
}
async function resolveCast(path: string | undefined): Promise<string> {
  const name = path ?? LOCAL_REPLAY_CAST.executable; requireFact(name.length > 0 && !name.includes("\0"), "configuration");
  const candidates = isAbsolute(name) ? [name] : name.includes("/") ? [join(process.cwd(), name)] :
    (process.env.PATH ?? "").split(":").filter(Boolean).map((folder: string) => join(folder, name));
  for (const file of candidates) { try { await access(file, constants.X_OK); return file; } catch { /* Try the next local PATH entry. */ } }
  return pending("engine_unavailable");
}
async function runCast(binary: string, args: readonly string[], options: LocalReplayOptions, deadline: number, cwd: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, [...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
      // RPC URLs and keys occur only in child environment; no inherited signer
      // keys, Etherscan key, debug logging, remote shell or project dotenv.
      env: { PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TMPDIR: process.env.TMPDIR, ETH_RPC_URL: options.rpcUrl,
        FOUNDRY_OFFLINE: "true", FOUNDRY_FFI: "false", FOUNDRY_DISABLE_NIGHTLY_WARNING: "true" } });
    let output = "", diagnostics = "", bytesSeen = 0, failure: LocalReplayPendingError | undefined;
    const stop = (code: LocalReplayPendingCode) => { failure ??= new LocalReplayPendingError(code); child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("timeout"), Math.max(1, deadline - Date.now()));
    child.stdout.on("data", data => { bytesSeen += data.length; if (bytesSeen > MAX_BYTES) stop("resource_limit"); else output += data.toString(); });
    child.stderr.on("data", data => { bytesSeen += data.length; if (bytesSeen > MAX_BYTES) stop("resource_limit"); else diagnostics += data.toString(); });
    child.on("error", () => { clearTimeout(timer); reject(new LocalReplayPendingError("engine_unavailable")); });
    child.on("close", code => { clearTimeout(timer); if (failure) reject(failure); else if (code !== 0 ||
      // cast can exit zero after a receipt/gas divergence. Only its exact
      // progress message is permitted; diagnostic text is never returned.
      diagnostics.split(/\r?\n/).some(line => line.trim() && line.trim() !== "Executing previous transactions from the block."))
      reject(new LocalReplayPendingError("replay_failed")); else resolve(output); });
  });
}
// Source execution policy is independent of destination authentication. Updating
// a Robinhood validator must not force an unchanged Base transaction through the VM.
const SOURCE_REPLAY_POLICY = 1, RETRY_BASE_MS = 30_000, RETRY_MAX_MS = 30 * 60_000;
type CodeAnchor = { address: string; parent: Hex; target: Hex };
type ReplayCache = { id: string; protocol: "internal_native_source_replay_v1"; version: 1; binding: Hex; updatedAt: number;
  state: "running" | "pending" | "verified"; failures: number; lease?: { token: string; until: number }; retryAfter?: number;
  arena?: unknown; arenaFingerprint?: Hex; metadata?: LocalReplayMetadata; codeAnchors?: CodeAnchor[] };
const flights = new WeakMap<object, Map<string, Promise<{ trace: LocalReplayTrace; metadata: LocalReplayMetadata }>>>();
export async function replayBaseNativeTransaction<T extends PublicClient<Transport, any>>(client: T, txHash: Hex, options: LocalReplayOptions):
  Promise<{ trace: LocalReplayTrace; metadata: LocalReplayMetadata }> {
  // Singleflight spans the actual asynchronous operation, not a caller's outer
  // timeout. The persistent CAS lease also excludes a different host process.
  const deadline = optionsDeadline(options); requireFact(hash(txHash), "invalid_request");
  if (!options.auditStore) return replayTransaction(client, txHash, options);
  const map = flights.get(options.auditStore) ?? new Map(); flights.set(options.auditStore, map);
  const key = `${options.chainId}:${txHash.toLowerCase()}:${options.rpcUrl}`;
  let work = map.get(key);
  if (!work) { work = replayTransaction(client, txHash, options); map.set(key, work);
    void work.finally(() => { if (map.get(key) === work) map.delete(key); }).catch(() => {}); }
  return structuredClone(await bounded(() => work!, deadline));
}
async function replayTransaction<T extends PublicClient<Transport, any>>(client: T, txHash: Hex, options: LocalReplayOptions):
  Promise<{ trace: LocalReplayTrace; metadata: LocalReplayMetadata }> {
  const deadline = optionsDeadline(options); requireFact(hash(txHash), "invalid_request");
  // The local engine and canonical reader must use the same explicit HTTP
  // endpoint. A URL for another chain cannot be paired with a healthy reader.
  requireFact(client.transport?.type === "http" && client.transport.url === options.rpcUrl, "configuration");
  // The pinned OP executor is not a reviewed Robinhood Nitro backend.
  // Never relabel chain 4663 as another Arbitrum chain to enable heuristics.
  if (options.chainId === 4663) pending("unsupported_vm");
  const request = async (method: string, params: unknown[]): Promise<any> => {
    try { return await bounded(() => (client.request as any)({ method, params }), deadline); }
    catch (error) { if (error instanceof LocalReplayPendingError) throw error; return pending("rpc_unavailable"); }
  };
  const snapshot = async (): Promise<LocalReplaySnapshot> => {
    const [chain, transaction, receipt] = await Promise.all([request("eth_chainId", []), request("eth_getTransactionByHash", [txHash]), request("eth_getTransactionReceipt", [txHash])]);
    requireFact(transaction && receipt && transaction.blockNumber, "missing_history");
    const n = quantity(transaction.blockNumber, "missing_history"); requireFact(n > 0n, "missing_history");
    const [block, parentBlock] = await Promise.all([request("eth_getBlockByNumber", [hexQuantity(n), true]), request("eth_getBlockByNumber", [hexQuantity(n - 1n), false])]);
    requireFact(block && parentBlock, "missing_history");
    const s = { chainId: Number(quantity(chain, "wrong_chain")), transaction, receipt, block, parentBlock };
    validateLocalReplaySnapshot(s, options.chainId, txHash); return s;
  };
  const codeBinding = async (s: LocalReplaySnapshot, codeAddresses: Set<Address>): Promise<CodeAnchor[]> => {
    requireFact(codeAddresses.size <= 128, "resource_limit");
    const entries: CodeAnchor[] = [], ordered = [...codeAddresses].sort();
    for (let start = 0; start < ordered.length; start += 4) {
      entries.push(...await Promise.all(ordered.slice(start, start + 4).map(async addr => {
        const [parentCode, targetCode] = await Promise.all([request("eth_getCode", [addr, s.parentBlock.number]), request("eth_getCode", [addr, s.block.number])]);
        requireFact(bytes(parentCode) && bytes(targetCode) && same(parentCode, targetCode), "changed_code");
        return { address: addr.toLowerCase(), parent: keccak256(parentCode), target: keccak256(targetCode) };
      })));
    }
    return entries;
  };
  const addresses = (trace: LocalReplayTrace) => { const result = new Set<Address>();
    const walk = (node: LocalReplayTrace) => { result.add(node.from); result.add(node.to); node.calls.forEach(walk); }; walk(trace); return result; };
  const closeAnchors = async (s: LocalReplaySnapshot) => {
    const [chain, block, parent] = await Promise.all([request("eth_chainId", []), request("eth_getBlockByNumber", [s.block.number, false]), request("eth_getBlockByNumber", [s.parentBlock.number, false])]);
    requireFact(quantity(chain, "wrong_chain") === BigInt(options.chainId), "wrong_chain");
    requireFact(block && parent && same(block.hash, s.block.hash) && same(parent.hash, s.parentBlock.hash) && same(block.parentHash, s.parentBlock.hash), "noncanonical");
  };
  const binding = fingerprint({ sourcePolicy: SOURCE_REPLAY_POLICY, chainId: options.chainId, transactionHash: txHash.toLowerCase(),
    cast: LOCAL_REPLAY_CAST, sourceCodePolicy: BUYBACK_CODE_HASHES, vm: "op-full-system-prefix-netgas-v1" });
  const id = `internal_native_source_replay:${binding}`, store = options.auditStore;
  const writer = store && "compareAndSetBuybackAudit" in store ? store : undefined;
  let expected: Awaited<ReturnType<BaseAuditStore["getBuybackBatch"]>> = null, lease: ReplayCache | undefined;
  const cacheWork = async <V>(work: () => Promise<V>): Promise<V> => {
    try { return await bounded(work, deadline); } catch (error) { if (error instanceof LocalReplayPendingError) throw error; return pending("cache_unavailable"); }
  };
  const validBase = (row: any): row is ReplayCache => row?.id === id && row.protocol === "internal_native_source_replay_v1" && row.version === 1 && row.binding === binding &&
    Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0 && row.updatedAt <= Date.now() && Number.isSafeInteger(row.failures) && row.failures >= 0 && row.failures <= 16;
  let cwd: string | undefined;
  try {
    if (store) {
      expected = await cacheWork(() => Promise.resolve(store.getBuybackBatch(id)));
      if (validBase(expected) && expected.state === "running" && typeof expected.lease?.token === "string" &&
        Number.isSafeInteger(expected.lease.until) && expected.lease.until <= expected.updatedAt + 90_000 && expected.lease.until > Date.now()) pending("cache_busy");
      if (validBase(expected) && ["pending", "verified"].includes(expected.state) && Number.isSafeInteger(expected.retryAfter) &&
        expected.retryAfter! <= expected.updatedAt + RETRY_MAX_MS && expected.retryAfter! > Date.now()) pending("retry_backoff");
    }
    const before = await snapshot();
    if (validBase(expected) && expected.state === "verified" && expected.metadata?.version === 2 &&
      expected.metadata.chainId === options.chainId && same(expected.metadata.transactionHash, txHash) && expected.metadata.castVersion === LOCAL_REPLAY_CAST.version &&
      expected.metadata.castSha256 === LOCAL_REPLAY_CAST.sha256 && expected.metadata.fullReplay === true && expected.metadata.systemTransactionsReplayed === true &&
      expected.metadata.blockAccessListUsed === false && expected.metadata.replayGasUsedForBudget === false && Array.isArray(expected.codeAnchors) && expected.codeAnchors.length <= 128 &&
      expected.codeAnchors.every(row => address(row.address) && hash(row.parent) && hash(row.target)) &&
      hash(expected.arenaFingerprint) && (JSON.stringify(expected.arena)?.length ?? Infinity) <= MAX_BYTES && expected.arenaFingerprint === fingerprint(expected.arena) &&
      expected.metadata.snapshotFingerprint === snapshotBinding(before) && expected.metadata.receiptFingerprint === localReplayReceiptFingerprint(before.receipt) &&
      same(expected.metadata.blockHash, before.block.hash) && expected.metadata.blockNumber === String(quantity(before.block.number)) &&
      expected.metadata.transactionIndex === String(quantity(before.transaction.transactionIndex)) && expected.metadata.inputHash === keccak256(before.transaction.input)) {
      let result: ReturnType<typeof validateLocalReplayEvidence> | undefined;
      // A corrupted private cache is discarded. It is never treated as a
      // source failure, a failed financial transaction, or an accepted proof.
      try { result = validateLocalReplayEvidence(before, expected.arena, options.chainId, txHash); } catch { /* Replay from canonical state below. */ }
      if (result && fingerprint(expected.codeAnchors) === expected.metadata.codeFingerprint) {
        const freshCodes = await codeBinding(before, addresses(result.trace));
        if (fingerprint(freshCodes) === expected.metadata.codeFingerprint) {
          await closeAnchors(before); requireFact(Date.now() < deadline, "timeout");
          if (writer && (expected.failures !== 0 || expected.retryAfter !== undefined)) {
            const recovered: ReplayCache = { ...expected, updatedAt: Date.now(), failures: 0, retryAfter: undefined };
            // Counter cleanup is advisory after the complete cached result has
            // passed fresh canonical checks. Losing this CAS cannot overwrite
            // its winner or invalidate that independently checked source fact.
            await cacheWork(() => Promise.resolve(writer.compareAndSetBuybackAudit(recovered, expected))).catch(() => {});
          }
          return { trace: result.trace, metadata: expected.metadata };
        }
      }
    }
    if (writer) {
      lease = { id, protocol: "internal_native_source_replay_v1", version: 1, binding, updatedAt: Date.now(), state: "running",
        failures: validBase(expected) && expected.state !== "verified" ? expected.failures : 0, lease: { token: randomUUID(), until: deadline + 30_000 } };
      if (!await cacheWork(() => Promise.resolve(writer.compareAndSetBuybackAudit(lease!, expected)))) { lease = undefined; pending("cache_busy"); }
    }
    const binary = await bounded(() => resolveCast(options.castPath), deadline);
    const executable = await bounded(() => readFile(binary), deadline);
    requireFact(createHash("sha256").update(executable).digest("hex") === LOCAL_REPLAY_CAST.sha256, "unreviewed_engine");
    cwd = await mkdtemp(join(tmpdir(), "musegod-local-replay-"));
    const version = await runCast(binary, ["--version"], options, deadline, cwd);
    requireFact(version.includes(`cast Version: ${LOCAL_REPLAY_CAST.version}`) && version.includes(`Commit SHA: ${LOCAL_REPLAY_CAST.commit}`), "unreviewed_engine");
    const raw = await runCast(binary, ["run", txHash, "--no-bal", "--replay-system-txes", "--json", "--disable-external-identification",
      "--rpc-timeout", String(Math.max(1, Math.min(15, Math.ceil((deadline - Date.now()) / 1000))))], options, deadline, cwd);
    let arena: unknown; try { arena = JSON.parse(raw); } catch { return pending("unsupported_arena"); }
    const result = validateLocalReplayEvidence(before, arena, options.chainId, txHash);
    const codeAddresses = addresses(result.trace), codes = await codeBinding(before, codeAddresses), codeBefore = fingerprint(codes);
    const after = await snapshot(), codeAfter = fingerprint(await codeBinding(after, codeAddresses));
    requireFact(snapshotBinding(before) === snapshotBinding(after) && codeBefore === codeAfter, "noncanonical");
    // Code reads by number can cross a reorg after the second snapshot. Close
    // that window with fresh canonical parent/target anchors and chain identity.
    await closeAnchors(before);
    requireFact(Date.now() < deadline, "timeout");
    const metadata: LocalReplayMetadata = { version: 2, chainId: options.chainId, transactionHash: txHash,
      blockHash: before.block.hash, blockNumber: String(quantity(before.block.number)), transactionIndex: String(quantity(before.transaction.transactionIndex)),
      receiptFingerprint: localReplayReceiptFingerprint(before.receipt), inputHash: keccak256(before.transaction.input),
      snapshotFingerprint: snapshotBinding(before), codeFingerprint: codeBefore, castVersion: LOCAL_REPLAY_CAST.version,
      castSha256: LOCAL_REPLAY_CAST.sha256, fullReplay: true, systemTransactionsReplayed: true, blockAccessListUsed: false,
      replayGasUsedForBudget: false };
    if (writer && lease) {
      const next: ReplayCache = { ...lease, state: "verified", failures: 0, updatedAt: Date.now(), lease: undefined,
        arena, arenaFingerprint: fingerprint(arena), metadata, codeAnchors: codes };
      if (!await cacheWork(() => Promise.resolve(writer.compareAndSetBuybackAudit(next, lease!)))) { lease = undefined; pending("cache_busy"); }
      lease = undefined;
    }
    return { trace: result.trace, metadata };
  } catch (error) {
    if (writer && lease) {
      const failures = Math.min(16, lease.failures + 1), updatedAt = Date.now();
      const next: ReplayCache = { ...lease, state: "pending", updatedAt, failures, lease: undefined,
        retryAfter: updatedAt + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1)) };
      // Failure metadata never changes financial journals. A lost lease cannot
      // erase a different process's newer successful proof.
      await bounded(() => Promise.resolve(writer.compareAndSetBuybackAudit(next, lease!)), Date.now() + 2_000).catch(() => {});
    } else if (writer && validBase(expected) && expected.state === "verified" && error instanceof LocalReplayPendingError &&
      ["rpc_unavailable", "timeout"].includes(error.code)) {
      // An unavailable reader cannot revoke a successful VM result. Retain it
      // with a retry clock, and keep the caller pending until fresh anchors can
      // be proved again. This clock never permits source spending or attribution.
      const failures = Math.min(16, expected.failures + 1), updatedAt = Date.now();
      const next: ReplayCache = { ...expected, updatedAt, failures, retryAfter: updatedAt + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1)) };
      await bounded(() => Promise.resolve(writer.compareAndSetBuybackAudit(next, expected)), Date.now() + 2_000).catch(() => {});
    }
    if (error instanceof LocalReplayPendingError) throw error;
    return pending("replay_failed");
  } finally { if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {}); }
}
export function createLocalReplayClient<T extends PublicClient<Transport, any>>(client: T, options: LocalReplayOptions): T {
  // Validate configuration without invoking RPC, subprocesses or filesystem IO.
  optionsDeadline(options);
  const originalRequest = client.request.bind(client);
  return new Proxy(client, { get(target, key, receiver) {
    if (key !== "request") return Reflect.get(target, key, receiver);
    return async (request: any, ...rest: any[]) => {
      if (request?.method !== "debug_traceTransaction") return (originalRequest as any)(request, ...rest);
      const p = request.params;
      requireFact(Array.isArray(p) && p.length === 2 && hash(p[0]) && p[1] && typeof p[1] === "object" && !Array.isArray(p[1]) &&
        Object.keys(p[1]).length === 1 && p[1].tracer === "callTracer", "invalid_request");
      return (await replayBaseNativeTransaction(target, p[0], options)).trace;
    };
  } });
}
