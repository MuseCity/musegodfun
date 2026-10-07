import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, keccak256, parseAbi, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import deployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { readFeePoolCurrencies, verifyFeeEngine, type BuybackDeployment } from "../server/buyback-engine";
import { BUYBACK_WETH, BUYBACK_FORWARDER_ALLOWANCE_CAP, buybackAmountCandidates, buybackVaultAbi, engineTransaction, feeEngineAbi, type BuybackEngineStatus, type EngineAction, type EngineConversionQuote } from "../src/lib/buyback-engine";
import { sameAddress, type RuntimeConfig } from "../src/lib/config";
import { ENGINE_FEE_POLICY, MUSEGOD_BUYBACK } from "../src/lib/fee-policy";

export type KeeperTask = { id: string; action: EngineAction; label: string } | { id: string; token: Address; amount: string; kind: "conversion"; label: string };
export function keeperApiOrigin(raw: string): string {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("The keeper API must be an HTTPS origin or an explicit loopback test origin");
  return url.origin;
}
export function keeperProfitThreshold(gasMuseQuote: bigint): bigint {
  if (gasMuseQuote <= 0n) throw new Error("A positive reference price for gas is required");
  return (gasMuseQuote * 120n + 99n) / 100n;
}
export function keeperGasCost(gas: bigint, gasPrice: bigint): bigint {
  if (gas <= 0n || gasPrice <= 0n) throw new Error("A valid gas estimate and gas price are required");
  return gas * gasPrice;
}
export function assertKeeperNonceReady(latest: number, pending: number) {
  if (!Number.isSafeInteger(latest) || !Number.isSafeInteger(pending) || latest < 0 || pending !== latest)
    throw new Error("Wait for the dedicated keeper wallet's pending transaction before submitting another task");
}
export type KeeperJournal = {
  schemaVersion: 1; chainId: number; caller: Address; nonce: number; taskId: string;
  hash: Hash; to: Address; dataHash: Hash; value: "0"; gasLimit: string; gasPrice: string;
  signedAt: number; status: "signed" | "broadcast" | "confirmed" | "reverted";
  blockNumber?: string; blockHash?: Hash; gasSpent?: string; resolvedAt?: number;
};
const JOURNAL_FIELDS = ["schemaVersion", "chainId", "caller", "nonce", "taskId", "hash", "to", "dataHash", "value", "gasLimit", "gasPrice", "signedAt", "status", "blockNumber", "blockHash", "gasSpent", "resolvedAt"];
export class KeeperSigningStopped extends Error {
  constructor(message: string) { super(message); this.name = "KeeperSigningStopped"; }
}
export async function acquireKeeperJournalLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new KeeperSigningStopped("The keeper journal lock could not be acquired. Signing is stopped.");
    throw new KeeperSigningStopped("The keeper journal lock already exists. Signing is stopped; an operator must check the journal and all keeper processes before removing the lock.");
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }) + "\n"); await lock.sync(); }
  catch { throw new KeeperSigningStopped("The keeper journal lock could not be saved. Signing is stopped."); }
  finally { await lock.close(); }
  return async () => { await unlink(lockPath).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); };
}
export async function writeKeeperJournal(path: string, journal: KeeperJournal): Promise<void> {
  if (Object.keys(journal).some((key) => !JOURNAL_FIELDS.includes(key)))
    throw new KeeperSigningStopped("The keeper journal contains forbidden fields. Signing is stopped.");
  await writePublicJsonAtomic(path, journal);
}
async function writePublicJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}
export async function readKeeperJournal(path: string, chainId: number, caller: Address): Promise<KeeperJournal | null> {
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new KeeperSigningStopped("The keeper journal could not be read. Signing is stopped."); }
  let journal: KeeperJournal;
  try { journal = JSON.parse(content); } catch { throw new KeeperSigningStopped("The keeper journal is malformed. Signing is stopped."); }
  if (!journal || typeof journal !== "object" || Object.keys(journal).some((key) => !JOURNAL_FIELDS.includes(key)) ||
    journal.schemaVersion !== 1 || journal.chainId !== chainId || typeof journal.caller !== "string" || !sameAddress(journal.caller, caller) ||
    !Number.isSafeInteger(journal.nonce) || journal.nonce < 0 || typeof journal.taskId !== "string" || journal.taskId.length > 160 ||
    !/^0x[0-9a-fA-F]{64}$/.test(journal.hash) || !/^0x[0-9a-fA-F]{64}$/.test(journal.dataHash) || !/^0x[0-9a-fA-F]{40}$/.test(journal.to) ||
    journal.value !== "0" || !/^[1-9]\d{0,77}$/.test(journal.gasLimit) || !/^[1-9]\d{0,77}$/.test(journal.gasPrice) ||
    !Number.isSafeInteger(journal.signedAt) || journal.signedAt <= 0 || !["signed", "broadcast", "confirmed", "reverted"].includes(journal.status) ||
    (journal.blockNumber !== undefined && !/^\d{1,20}$/.test(journal.blockNumber)) || (journal.blockHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(journal.blockHash)) ||
    (journal.gasSpent !== undefined && !/^\d{1,78}$/.test(journal.gasSpent)) ||
    (journal.resolvedAt !== undefined && (!Number.isSafeInteger(journal.resolvedAt) || journal.resolvedAt < journal.signedAt)))
    throw new KeeperSigningStopped("The keeper journal identity or fields are invalid. Signing is stopped.");
  return journal;
}
type JournalReceipt = { status: "success" | "reverted"; transactionHash: Hash; from: Address; to: Address | null; blockNumber: bigint; blockHash: Hash; gasUsed?: bigint; effectiveGasPrice?: bigint };
type JournalTransaction = { hash: Hash; from: Address; to: Address | null; nonce: number; input: Hex; value: bigint };
export async function reconcileKeeperJournal(journal: KeeperJournal, deps: {
  receipt: (hash: Hash) => Promise<JournalReceipt>;
  transaction: (hash: Hash) => Promise<JournalTransaction>;
  head: () => Promise<bigint>;
  block: (blockNumber: bigint) => Promise<{ hash: Hash | null }>;
  persist: (journal: KeeperJournal) => Promise<void>;
}): Promise<KeeperJournal> {
  try {
    const [receipt, transaction, head] = await Promise.all([deps.receipt(journal.hash), deps.transaction(journal.hash), deps.head()]);
    const canonical = await deps.block(receipt.blockNumber);
    if (receipt.transactionHash.toLowerCase() !== journal.hash.toLowerCase() || transaction.hash.toLowerCase() !== journal.hash.toLowerCase() ||
      !sameAddress(receipt.from, journal.caller) || !sameAddress(transaction.from, journal.caller) ||
      !receipt.to || !transaction.to || !sameAddress(receipt.to, journal.to) || !sameAddress(transaction.to, journal.to) ||
      transaction.nonce !== journal.nonce || keccak256(transaction.input) !== journal.dataHash || transaction.value !== 0n ||
      head < receipt.blockNumber + 1n || canonical.hash !== receipt.blockHash)
      throw new Error("The prior transaction is not an exact canonical two-confirmation match");
    const gasSpent = receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined ? receipt.gasUsed * receipt.effectiveGasPrice : BigInt(journal.gasLimit) * BigInt(journal.gasPrice);
    if (gasSpent < 0n) throw new Error("The receipt gas cost is invalid");
    const status = receipt.status === "success" ? "confirmed" : "reverted";
    const confirmed: KeeperJournal = { ...journal, status, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash, gasSpent: String(gasSpent), resolvedAt: journal.blockHash === receipt.blockHash && journal.status === status ? journal.resolvedAt ?? Date.now() : Date.now() };
    await deps.persist(confirmed);
    // A canonical reverted receipt consumed its nonce and resolved the outcome.
    // The next round must rebuild and simulate before signing a fresh attempt.
    return confirmed;
  } catch (error) {
    if (error instanceof KeeperSigningStopped) throw error;
    throw new KeeperSigningStopped(`Keeper transaction ${journal.hash} has an unresolved outcome. Signing is stopped; inspect the retained journal before resuming.`);
  }
}
export async function submitJournaledKeeperTask(input: Omit<KeeperJournal, "schemaVersion" | "hash" | "signedAt" | "status">, deps: {
  sign: () => Promise<Hex>;
  persist: (journal: KeeperJournal) => Promise<void>;
  broadcast: (signedTransaction: Hex) => Promise<Hash>;
  confirm: (journal: KeeperJournal) => Promise<KeeperJournal>;
}): Promise<KeeperJournal> {
  const signedTransaction = await deps.sign();
  const journal: KeeperJournal = { ...input, schemaVersion: 1, hash: keccak256(signedTransaction), signedAt: Date.now(), status: "signed" };
  let persisted = false;
  try {
    // Only public transaction metadata is persisted. The locally signed raw
    // transaction and private key never enter the journal or console output.
    await deps.persist(journal);
    persisted = true;
    const receivedHash = await deps.broadcast(signedTransaction);
    if (receivedHash.toLowerCase() !== journal.hash.toLowerCase()) throw new Error("Broadcast returned a different transaction hash");
    const broadcast = { ...journal, status: "broadcast" as const };
    await deps.persist(broadcast);
    return await deps.confirm(broadcast);
  } catch (error) {
    if (error instanceof KeeperSigningStopped) throw error;
    if (!persisted) throw new KeeperSigningStopped(`Keeper transaction ${journal.hash} could not be journaled before broadcast. No transaction was broadcast; signing is stopped.`);
    throw new KeeperSigningStopped(`Keeper transaction ${journal.hash} could not be confirmed. Signing is stopped; its journal is retained.`);
  }
}
export class KeeperSubmissionBarrier {
  private stopped = false;
  get signingStopped() { return this.stopped; }
  async submit(input: Parameters<typeof submitJournaledKeeperTask>[0], deps: Parameters<typeof submitJournaledKeeperTask>[1]) {
    if (this.stopped) throw new KeeperSigningStopped("Signing remains stopped after an unresolved keeper transaction.");
    try { return await submitJournaledKeeperTask(input, deps); }
    catch (error) { if (error instanceof KeeperSigningStopped) this.stopped = true; throw error; }
  }
}
// These are keeper gas protections, independent of user transaction limits and
// the Vault's WETH budget. A resolved revert isolates only its own task.
export const KEEPER_TASK_RETRY_POLICY = {
  initialBackoffMs: 120_000, maximumBackoffMs: 3_600_000,
  attemptWindowMs: 3_600_000, maximumRevertsPerWindow: 3,
  gasWindowMs: 86_400_000, maximumFailedGasWei: 10n ** 15n,
  // Worst-case cost of one signed attempt (buffered gas limit × gas price).
  // Separate from failure history, so a revert overshoots the failed-gas
  // budget by at most this much and an unaffordable attempt says so itself.
  maximumAttemptGasWei: 2n * 10n ** 15n, gasRetryMs: 60_000,
} as const;
type KeeperTaskFailure = { hash: Hash; at: number; gasWei: string };
export type KeeperTaskRetryState = { consecutiveReverts: number; nextAttemptAt: number; lastOutcomeHash: Hash; lastOutcomeStatus: "confirmed" | "reverted"; lastOutcomeBlockHash?: Hash; lastOutcomeAt: number; failures: KeeperTaskFailure[] };
export type KeeperTaskStateFile = { schemaVersion: 1; chainId: number; caller: Address; tasks: Record<string, KeeperTaskRetryState> };
const validTaskId = (id: string) => /^(?:(?:sync|claim):0x[0-9a-fA-F]{64}|(?:forward|convert|burn|release):0x[0-9a-fA-F]{40}|forward:source|execute:weth)$/.test(id);
const onlyFields = (value: unknown, fields: string[]) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => fields.includes(key));
function validTaskState(state: KeeperTaskStateFile, chainId: number, caller: Address): boolean {
  return onlyFields(state, ["schemaVersion", "chainId", "caller", "tasks"]) && state.schemaVersion === 1 && state.chainId === chainId &&
    typeof state.caller === "string" && sameAddress(state.caller, caller) && !!state.tasks && typeof state.tasks === "object" && !Array.isArray(state.tasks) &&
    Object.entries(state.tasks).length <= 4096 && Object.entries(state.tasks).every(([id, row]) => validTaskId(id) &&
      onlyFields(row, ["consecutiveReverts", "nextAttemptAt", "lastOutcomeHash", "lastOutcomeStatus", "lastOutcomeBlockHash", "lastOutcomeAt", "failures"]) &&
      Number.isSafeInteger(row.consecutiveReverts) && row.consecutiveReverts >= 0 && row.consecutiveReverts <= 96 &&
      Number.isSafeInteger(row.nextAttemptAt) && row.nextAttemptAt >= 0 && Number.isSafeInteger(row.lastOutcomeAt) && row.lastOutcomeAt > 0 &&
      /^0x[0-9a-fA-F]{64}$/.test(row.lastOutcomeHash) && ["confirmed", "reverted"].includes(row.lastOutcomeStatus) &&
      (row.lastOutcomeBlockHash === undefined || /^0x[0-9a-fA-F]{64}$/.test(row.lastOutcomeBlockHash)) && Array.isArray(row.failures) && row.failures.length <= 96 &&
      row.failures.every((failure) => onlyFields(failure, ["hash", "at", "gasWei"]) && /^0x[0-9a-fA-F]{64}$/.test(failure.hash) &&
        Number.isSafeInteger(failure.at) && failure.at > 0 && /^\d{1,78}$/.test(failure.gasWei)));
}
export async function readKeeperTaskState(path: string, chainId: number, caller: Address): Promise<KeeperTaskStateFile> {
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, chainId, caller, tasks: {} }; throw new KeeperSigningStopped("The keeper task budgets could not be read. Signing is stopped."); }
  let state: KeeperTaskStateFile;
  try { state = JSON.parse(content); } catch { throw new KeeperSigningStopped("The keeper task budgets are malformed. Signing is stopped."); }
  if (!validTaskState(state, chainId, caller)) throw new KeeperSigningStopped("The keeper task budget identity or fields are invalid. Signing is stopped.");
  return state;
}
export async function writeKeeperTaskState(path: string, state: KeeperTaskStateFile): Promise<void> {
  if (!validTaskState(state, state.chainId, state.caller)) throw new KeeperSigningStopped("The keeper task budgets contain invalid or forbidden fields. Signing is stopped.");
  try { await writePublicJsonAtomic(path, state); }
  catch { throw new KeeperSigningStopped("The keeper task budgets could not be persisted. Signing is stopped."); }
}
export function recordKeeperTaskOutcome(state: KeeperTaskStateFile, journal: KeeperJournal): KeeperTaskStateFile {
  if (journal.status !== "confirmed" && journal.status !== "reverted") return state;
  if (state.chainId !== journal.chainId || !sameAddress(state.caller, journal.caller) || !validTaskId(journal.taskId))
    throw new KeeperSigningStopped("The resolved transaction differs from its keeper task budget identity.");
  const previous = state.tasks[journal.taskId];
  const sameHash = previous?.lastOutcomeHash.toLowerCase() === journal.hash.toLowerCase();
  if (sameHash && previous.lastOutcomeStatus === journal.status && previous.lastOutcomeBlockHash === journal.blockHash) return state;
  const at = journal.resolvedAt ?? journal.signedAt;
  const failures = (previous?.failures ?? []).filter((failure) => failure.at > at - KEEPER_TASK_RETRY_POLICY.gasWindowMs && (!sameHash || failure.hash.toLowerCase() !== journal.hash.toLowerCase()));
  const reverted = journal.status === "reverted";
  if (reverted && !failures.some((failure) => failure.hash.toLowerCase() === journal.hash.toLowerCase()))
    failures.push({ hash: journal.hash, at, gasWei: journal.gasSpent ?? String(BigInt(journal.gasLimit) * BigInt(journal.gasPrice)) });
  const priorConsecutive = previous && previous.lastOutcomeAt > at - KEEPER_TASK_RETRY_POLICY.gasWindowMs ? previous.consecutiveReverts : 0;
  const consecutiveReverts = reverted ? Math.min(96, priorConsecutive + (sameHash && previous.lastOutcomeStatus === "reverted" ? 0 : 1)) : 0;
  const nextAttemptAt = reverted ? at + Math.min(KEEPER_TASK_RETRY_POLICY.maximumBackoffMs, KEEPER_TASK_RETRY_POLICY.initialBackoffMs * 2 ** Math.min(30, consecutiveReverts - 1)) : 0;
  const tasks = Object.fromEntries(Object.entries(state.tasks).filter(([, row]) => row.lastOutcomeAt > at - KEEPER_TASK_RETRY_POLICY.gasWindowMs));
  tasks[journal.taskId] = { consecutiveReverts, nextAttemptAt, lastOutcomeHash: journal.hash, lastOutcomeStatus: journal.status, ...(journal.blockHash ? { lastOutcomeBlockHash: journal.blockHash } : {}), lastOutcomeAt: at, failures };
  return { ...state, tasks };
}
export function keeperTaskWait(state: KeeperTaskStateFile, taskId: string, attemptGasWei = 0n, now = Date.now()): { reason: string; nextAttemptAt: number } | null {
  const row = state.tasks[taskId];
  const failures = (row?.failures ?? []).filter((failure) => failure.at > now - KEEPER_TASK_RETRY_POLICY.gasWindowMs);
  if (attemptGasWei < 0n) throw new Error("The keeper attempt gas cost cannot be negative");
  if (attemptGasWei > KEEPER_TASK_RETRY_POLICY.maximumAttemptGasWei)
    return { reason: "This attempt's worst-case gas cost exceeds the single-attempt cap; waiting for a lower gas price", nextAttemptAt: now + KEEPER_TASK_RETRY_POLICY.gasRetryMs };
  const failedGas = failures.reduce((sum, failure) => sum + BigInt(failure.gasWei), 0n);
  if (failedGas >= KEEPER_TASK_RETRY_POLICY.maximumFailedGasWei)
    return { reason: "This task's rolling 24-hour failed-gas budget is used up", nextAttemptAt: Math.min(...failures.map((failure) => failure.at)) + KEEPER_TASK_RETRY_POLICY.gasWindowMs };
  const recent = failures.filter((failure) => failure.at > now - KEEPER_TASK_RETRY_POLICY.attemptWindowMs);
  if (recent.length >= KEEPER_TASK_RETRY_POLICY.maximumRevertsPerWindow)
    return { reason: "This task is waiting after repeated canonical reverts", nextAttemptAt: Math.min(...recent.map((failure) => failure.at)) + KEEPER_TASK_RETRY_POLICY.attemptWindowMs };
  if (row && row.nextAttemptAt > now) return { reason: "This task is backing off after a canonical revert", nextAttemptAt: row.nextAttemptAt };
  return null;
}

/** A canonical same-block balance check avoids paying to sync an already-accounted or unrelated donation. */
export async function keeperSyncHasNewCredit(client: Parameters<typeof readFeePoolCurrencies>[0] & { getBlockNumber: (input: { cacheTime: number }) => Promise<bigint> }, engine: Address, poolId: Hex): Promise<boolean> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const currencies = await readFeePoolCurrencies(client, { engine, blockNumber }, poolId);
  if (!currencies) return false;
  const deltas = await Promise.all(currencies.map(async (token) => {
    const [balance, pending] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [engine], blockNumber }),
      client.readContract({ address: engine, abi: feeEngineAbi, functionName: "pending", args: [token], blockNumber }),
    ]);
    return balance > pending;
  }));
  return deltas.some(Boolean);
}
export function selectKeeperTasks(status: BuybackEngineStatus, now = Date.now()): KeeperTask[] {
  if (!status.available) return [];
  const tasks: KeeperTask[] = [];
  const seen = new Set<string>();
  const untracked = new Set(status.assets.filter((asset) => BigInt(asset.untracked ?? "0") > 0n).map((asset) => asset.address.toLowerCase()));
  const shortfall = new Set(status.assets.filter((asset) => BigInt(asset.shortfall ?? "0") > 0n).map((asset) => asset.address.toLowerCase()));
  const syncCovered = new Set<string>();
  const add = (task: KeeperTask) => { if (!seen.has(task.id.toLowerCase())) { seen.add(task.id.toLowerCase()); tasks.push(task); } };
  for (const pool of status.pools) {
    const currencies = pool.currencies ?? [];
    if (currencies.some((token) => untracked.has(token.toLowerCase()) && !syncCovered.has(token.toLowerCase()))) {
      add({ id: `sync:${pool.poolId}`, action: { kind: "sync", poolId: pool.poolId }, label: "Account for externally pushed fees separately" });
      for (const token of currencies) syncCovered.add(token.toLowerCase());
    }
    // A claim collects both currencies at once. Income in a currency whose
    // engine balance is short of its recorded liability stays unspendable, so
    // only healthy income justifies an automatic claim; mixed income still does.
    if (pool.claimable?.some((asset) => !shortfall.has(asset.address.toLowerCase()) &&
      ((asset.lp !== null && BigInt(asset.lp) > 0n) || (asset.hook !== null && BigInt(asset.hook) > 0n))))
      add({ id: `claim:${pool.poolId}`, action: { kind: "claim", poolId: pool.poolId }, label: `Collect ${pool.symbol} pool fees` });
  }
  for (const asset of status.assets) {
    if (BigInt(asset.pending) === 0n || asset.pricing === "unknown" || asset.error) continue;
    if (sameAddress(asset.address, MUSEGOD_BUYBACK.tokenAddress)) {
      add({ id: `burn:${asset.address}`, action: { kind: "burn", amount: asset.pending }, label: "Transfer collected MUSEGOD to the dead address" });
    } else if (asset.pricing === "unsupported_static" && !sameAddress(asset.address, BUYBACK_WETH)) {
      add({ id: `release:${asset.address}`, action: { kind: "release_unpriced", token: asset.address, amount: asset.pending }, label: `Forward unpriced ${asset.symbol} buyback fees to Splits Automation` });
    } else if (asset.pricing === "supported" && BigInt(asset.available) > 0n && asset.referenceWeth !== null && BigInt(asset.referenceWeth) > 0n && !asset.error) {
      if (sameAddress(asset.address, BUYBACK_WETH)) add({ id: `forward:${asset.address}`, action: { kind: "forward", amount: asset.available }, label: "Forward available WETH fees" });
      else add({ id: `convert:${asset.address}`, kind: "conversion", token: asset.address, amount: asset.available, label: `Convert available ${asset.symbol} fees to WETH` });
    }
  }
  if (status.sourceDeployed && status.sourceWeth !== null && status.sourceAllowance !== null) {
    const balance = BigInt(status.sourceWeth), allowance = BigInt(status.sourceAllowance);
    const amount = balance < allowance ? balance : allowance;
    if (amount > 0n && allowance <= BUYBACK_FORWARDER_ALLOWANCE_CAP) add({ id: "forward:source", action: { kind: "forward_source", amount: String(amount) }, label: "Forward authorized source treasury WETH to the fixed budget vault (no caller reward)" });
  }
  if (status.vaultAvailable && BigInt(status.vaultAvailable) > 0n && !status.buybackWaitReason)
    add({ id: "execute:weth", action: { kind: "execute", amount: status.vaultAvailable, minProfit: "1", deadline: Math.floor(now / 1000) + 60 }, label: "Settle WETH/MUSEGOD Swapper offer" });
  return tasks;
}
export function assertKeeperGraph(config: RuntimeConfig, status: BuybackEngineStatus, manifest: BuybackDeployment = deployment) {
  const graph = manifest.contracts, constant = manifest.constants, automation = manifest.automation;
  if (manifest.status !== "deployed_verified" || manifest.schemaVersion !== 2 || manifest.chainId !== 4663 || config.feePolicy !== ENGINE_FEE_POLICY ||
    !config.feeEngine || !config.buybackVault || !config.assetFeedOracle || !config.buybackExecutor || !config.treasury || !config.automationReceiver || !config.automationTreasury || !config.wethForwarder ||
    !status.available || !status.vault || !status.assetOracle || !status.engine || !status.swapper || !status.executor || !status.operationsTreasury || !status.automationReceiver || !status.automationTreasury || !status.wethForwarder ||
    !status.sourceDeployed || status.sourceAllowance === null ||
    !graph.vault?.address || !graph.assetOracle?.address || !graph.engine.address || !graph.swapper.address || !graph.executor.address || !graph.forwarder.address ||
    [constant.treasury, constant.automation, constant.automationTreasury, ...Object.values(graph).map((entry) => entry.address)].some((address) => !address || sameAddress(address, "0x0000000000000000000000000000000000000000")) ||
    new Set([constant.treasury, constant.automation, constant.automationTreasury, ...Object.values(graph).map((entry) => entry.address)].map((address) => address?.toLowerCase())).size !== 10 ||
    !automation || automation.status !== "configured" || !automation.account || !sameAddress(automation.account, constant.automation!) ||
    automation.network !== 4663 || !sameAddress(automation.outputToken, constant.weth) || automation.allocationBps !== 10_000 || !sameAddress(automation.recipient, constant.automationTreasury!) ||
    !sameAddress(config.buybackVault, graph.vault.address) || !sameAddress(config.assetFeedOracle, graph.assetOracle.address) || !sameAddress(config.feeEngine, graph.engine.address) || !sameAddress(config.buybackExecutor, graph.executor.address) ||
    !sameAddress(status.vault, graph.vault.address) || !sameAddress(status.assetOracle, graph.assetOracle.address) || !sameAddress(status.engine, graph.engine.address) || !sameAddress(status.swapper, graph.swapper.address) || !sameAddress(status.executor, graph.executor.address) ||
    !sameAddress(config.treasury, constant.treasury) || !sameAddress(status.operationsTreasury, constant.treasury) ||
    !sameAddress(config.automationReceiver, constant.automation!) || !sameAddress(status.automationReceiver, constant.automation!) ||
    !sameAddress(config.automationTreasury, constant.automationTreasury!) || !sameAddress(status.automationTreasury, constant.automationTreasury!) ||
    !sameAddress(config.wethForwarder, graph.forwarder.address) || !sameAddress(status.wethForwarder, graph.forwarder.address) ||
    !((config.chainId === 4663 && config.mode === "robinhood") || (config.chainId === 31337 && config.mode === "fork" && config.deploymentChainId === 4663)))
    throw new Error("The keeper API graph does not match the reviewed deployment manifest");
}
export function assertKeeperAccount(caller: Address, config: RuntimeConfig) {
  if ([config.treasury, config.automationReceiver, config.automationTreasury].some((address) => address && sameAddress(address, caller)))
    throw new Error("The dedicated keeper must not use the operations treasury, Splits Automation or source treasury account");
}
export function assertKeeperDeploymentAccount(caller: Address, keys: (string | undefined)[]) {
  for (const raw of keys) {
    const key = raw?.trim().replace(/^0x/i, "");
    if (key && /^[0-9a-fA-F]{64}$/.test(key) && sameAddress(privateKeyToAccount(`0x${key}`).address, caller))
      throw new Error("The keeper must not reuse a deployment account");
  }
}
export function redactKeeperError(error: unknown, secrets: (string | undefined)[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret?.trim()) {
    const pattern = secret.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    message = message.replace(new RegExp(pattern, "gi"), "[redacted]");
  }
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, "[upstream]").slice(0, 500);
}
const oracleAbi = parseAbi(["function quoteWethToMuse(uint256 amount) view returns(uint256)"]);
async function readApi<T>(origin: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}/api${path}`, { redirect: "manual", signal: AbortSignal.timeout(35_000),
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`The keeper API request failed (${response.status})`);
  const text = await response.text();
  if (text.length > 1_048_576) throw new Error("The keeper API response exceeds the size limit");
  return JSON.parse(text) as T;
}
export async function runKeeper(args = process.argv.slice(2)) {
  if (args.some((arg) => !["--execute", "--once"].includes(arg) && !arg.startsWith("--api="))) throw new Error("Use --once, --execute, or --api=https://your-platform-origin");
  if (args.filter((arg) => arg.startsWith("--api=")).length > 1) throw new Error("Select one keeper API origin");
  try { process.loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to load the local keeper environment"); }
  const execute = args.includes("--execute"), once = args.includes("--once");
  const origin = keeperApiOrigin(args.find((arg) => arg.startsWith("--api="))?.slice(6) || "https://musegod.fun");
  const rawKey = process.env.MUSEGOD_KEEPER_PRIVATE_KEY;
  if (execute && (!rawKey || !/^0x[0-9a-fA-F]{64}$/.test(rawKey))) throw new Error("Execution requires a dedicated local MUSEGOD_KEEPER_PRIVATE_KEY");
  const account = rawKey && /^0x[0-9a-fA-F]{64}$/.test(rawKey) ? privateKeyToAccount(rawKey as Hex) : null;
  if (account) assertKeeperDeploymentAccount(account.address, [process.env.MUSEGOD_DEPLOY_PRIVATE_KEY, process.env.EVM_DY]);
  const deploymentSenders = (deployment.transactions as Record<string, unknown>[]).flatMap((transaction) => typeof transaction.deployer === "string" ? [transaction.deployer] : []);
  if (account && deploymentSenders.some((address) => sameAddress(address, account.address))) throw new Error("The keeper must not reuse a deployment account");
  const attempted = new Map<string, number>();
  const submission = new KeeperSubmissionBarrier();
  const safeError = (error: unknown) => redactKeeperError(error, [rawKey, process.env.MUSEGOD_DEPLOY_PRIVATE_KEY, process.env.EVM_DY, process.env.ALCHEMY_API_KEY, process.env.ROBINHOOD_RPC_URL, process.env.FORK_RPC_URL]);
  let stopping = false;
  let journalPath: string | null = null;
  let taskStatePath: string | null = null;
  let taskState: KeeperTaskStateFile | null = null;
  let releaseJournalLock: (() => Promise<void>) | null = null;
  const stopSigning = (error: unknown) => {
    stopping = true; process.exitCode = 1;
    console.log(JSON.stringify({ state: "signing_stopped", journal: journalPath, reason: safeError(error) }));
  };
  let wakeWait: (() => void) | null = null;
  const stop = () => { stopping = true; wakeWait?.(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { do {
    const startedAt = Date.now();
    try {
      const [config, status] = await Promise.all([readApi<RuntimeConfig>(origin, "/config"), readApi<BuybackEngineStatus>(origin, "/buyback/engine")]);
      if (!status.available) { console.log(JSON.stringify({ mode: execute ? "execute" : "dry_run", state: "waiting", reason: status.reason })); }
      else {
        assertKeeperGraph(config, status);
        const localApi = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
        if (config.chainId === 31337 && !localApi) throw new Error("Fork execution requires an explicit loopback API");
        if (account) assertKeeperAccount(account.address, config);
        const rpcUrl = config.chainId === 31337 ? process.env.FORK_RPC_URL || "http://127.0.0.1:8547"
          : process.env.ALCHEMY_API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${encodeURIComponent(process.env.ALCHEMY_API_KEY)}`
          : process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
        const rpc = new URL(rpcUrl);
        if (config.chainId === 31337 ? !["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname) : rpc.protocol !== "https:")
          throw new Error("The keeper RPC is not on the expected HTTPS or loopback network");
        const chain = defineChain({ ...robinhood, id: config.chainId, name: config.chainId === 31337 ? "Keeper local fork" : robinhood.name });
        const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
        if (await client.getChainId() !== config.chainId) throw new Error("The keeper RPC network differs from the platform");
        const graph = await verifyFeeEngine(client, config.feeEngine!);
        // Dry runs never create a signing wallet. A public stand-in address is
        // sufficient to simulate permissionless claims and Swapper execution.
        const caller = account?.address || "0x0000000000000000000000000000000000000001" as Address;
        const tasks = selectKeeperTasks(status);
        console.log(JSON.stringify({ mode: execute ? "execute" : "dry_run", chainId: config.chainId, tasks: tasks.length, blockNumber: String(graph.blockNumber) }));
        const wallet = execute && account ? createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) }) : null;
        const persist = async (journal: KeeperJournal) => {
          if (!taskState || !taskStatePath) throw new KeeperSigningStopped("Keeper task budgets were not loaded before submission.");
          const updated = recordKeeperTaskOutcome(taskState, journal);
          // Persist a resolved task's gas/backoff before its journal may be
          // replaced by another task. Restart reconciliation is idempotent.
          if (updated !== taskState) { await writeKeeperTaskState(taskStatePath, updated); taskState = updated; }
          await writeKeeperJournal(journalPath!, journal);
        };
        const reconcile = (journal: KeeperJournal) => reconcileKeeperJournal(journal, {
          receipt: (hash) => client.getTransactionReceipt({ hash }), transaction: (hash) => client.getTransaction({ hash }),
          head: () => client.getBlockNumber({ cacheTime: 0 }), block: (blockNumber) => client.getBlock({ blockNumber }), persist,
        });
        if (wallet) {
          const selectedPath = resolve(".cache/buyback-keeper", `${config.chainId}-${caller.toLowerCase()}.json`);
          if (journalPath && journalPath !== selectedPath) throw new KeeperSigningStopped("The keeper network changed while running. Signing is stopped.");
          journalPath = selectedPath;
          if (!releaseJournalLock) releaseJournalLock = await acquireKeeperJournalLock(journalPath);
          taskStatePath = `${selectedPath}.tasks.json`;
          taskState = await readKeeperTaskState(taskStatePath, config.chainId, caller);
          const previous = await readKeeperJournal(journalPath, config.chainId, caller);
          if (previous) { await reconcile(previous); attempted.set(previous.taskId, Math.max(attempted.get(previous.taskId) ?? 0, previous.signedAt)); }
        }
        for (const task of tasks) {
          if (stopping) break;
          const wait = taskState && keeperTaskWait(taskState, task.id);
          if (wallet && wait) { console.log(JSON.stringify({ task: task.id, state: "waiting", ...wait })); continue; }
          if ((attempted.get(task.id) ?? 0) + 60_000 > Date.now()) continue;
          attempted.set(task.id, Date.now());
          try {
            let action: EngineAction;
            if ("kind" in task) {
              const quote = await readApi<EngineConversionQuote>(origin, "/buyback/engine/quote", { token: task.token, amount: task.amount, caller });
              if (quote.action.kind !== "convert" || !sameAddress(quote.action.token, task.token) || quote.action.amount !== task.amount || quote.expiresAt !== quote.action.deadline * 1000)
                throw new Error("The conversion preview changed its input or expiry");
              action = quote.action;
            } else action = { ...task.action };
            if (action.kind === "sync" && !await keeperSyncHasNewCredit(client, graph.engine, action.poolId)) {
              console.log(JSON.stringify({ task: task.id, state: "skipped", reason: "No new credit remains in this verified pool's currencies" })); continue;
            }
            if (action.kind === "execute") {
              let selected: Extract<EngineAction, { kind: "execute" }> | null = null;
              for (const amount of buybackAmountCandidates(BigInt(action.amount))) {
                if (stopping) break;
                const deadline = Math.floor(Date.now() / 1000) + 59;
                const args = [amount, 1n, BigInt(deadline)] as const;
                try {
                  const [simulation, gas, gasPrice] = await Promise.all([
                    client.simulateContract({ address: graph.vault, abi: buybackVaultAbi, functionName: "execute", args, account: caller }),
                    client.estimateContractGas({ address: graph.vault, abi: buybackVaultAbi, functionName: "execute", args, account: caller }),
                    client.getGasPrice(),
                  ]);
                  const gasMuse = await client.readContract({ address: graph.oracle, abi: oracleAbi, functionName: "quoteWethToMuse", args: [keeperGasCost(gas, gasPrice)] });
                  const minimumProfit = keeperProfitThreshold(gasMuse);
                  if (simulation.result[1] < minimumProfit) continue;
                  await client.simulateContract({ address: graph.vault, abi: buybackVaultAbi, functionName: "execute", args: [amount, minimumProfit, BigInt(deadline)], account: caller });
                  selected = { kind: "execute", amount: String(amount), minProfit: String(minimumProfit), deadline };
                  break;
                } catch { /* A failed size is only simulated; smaller sizes retain the same price floor. */ }
              }
              if (!selected) { console.log(JSON.stringify({ task: task.id, state: "waiting", reason: "No tested trade size covers estimated gas plus 20%" })); continue; }
              action = selected;
            }
            let tx = engineTransaction(action, config);
            await client.call({ account: caller, ...tx });
            const [gas, gasPrice] = await Promise.all([client.estimateGas({ account: caller, ...tx }), client.getGasPrice()]);
            if (action.kind === "execute") {
              const finalGasMuse = await client.readContract({ address: graph.oracle, abi: oracleAbi, functionName: "quoteWethToMuse", args: [keeperGasCost(gas, gasPrice)] });
              const finalMinimum = keeperProfitThreshold(finalGasMuse);
              if (finalMinimum > BigInt(action.minProfit)) action.minProfit = String(finalMinimum);
              tx = engineTransaction(action, config);
              // The second gas snapshot may increase the caller minimum. Re-run
              // the complete trade with that final threshold before submission.
              await client.call({ account: caller, ...tx });
            }
            if (!wallet) { console.log(JSON.stringify({ task: task.id, state: "simulated", gas: String(gas), estimatedGasWei: String(keeperGasCost(gas, gasPrice)) })); continue; }
            const current = await readApi<RuntimeConfig>(origin, "/config");
            assertKeeperGraph(current, status);
            if (!current.writesEnabled || current.chainId !== config.chainId || current.mode !== config.mode)
              throw new Error("Platform execution is disabled or its network changed");
            assertKeeperAccount(caller, current);
            engineTransaction(action, current); // Recheck every expiry immediately before signing.
            const gasLimit = (gas * 125n + 99n) / 100n;
            const [latestNonce, pendingNonce] = await Promise.all([
              client.getTransactionCount({ address: caller, blockTag: "latest" }),
              client.getTransactionCount({ address: caller, blockTag: "pending" }),
            ]);
            assertKeeperNonceReady(latestNonce, pendingNonce);
            if (await client.getBalance({ address: caller, blockTag: "pending" }) < keeperGasCost(gasLimit, gasPrice)) throw new Error("The dedicated keeper wallet has insufficient gas funds");
            await client.call({ account: caller, ...tx });
            if (stopping) throw new Error("The keeper stopped before signing");
            const previous = await readKeeperJournal(journalPath!, config.chainId, caller);
            if (previous) await reconcile(previous);
            const budgetWait = keeperTaskWait(taskState!, task.id, keeperGasCost(gasLimit, gasPrice));
            if (budgetWait) { console.log(JSON.stringify({ task: task.id, state: "waiting", ...budgetWait })); continue; }
            if (action.kind === "sync" && !await keeperSyncHasNewCredit(client, graph.engine, action.poolId)) {
              console.log(JSON.stringify({ task: task.id, state: "skipped", reason: "Another transaction already accounted for this pool's new credit" })); continue;
            }
            const confirmed = await submission.submit({ chainId: config.chainId, caller, nonce: latestNonce, taskId: task.id, to: tx.to, dataHash: keccak256(tx.data), value: "0", gasLimit: String(gasLimit), gasPrice: String(gasPrice) }, {
              sign: () => {
                if (stopping) throw new KeeperSigningStopped("The keeper stopped before signing.");
                engineTransaction(action, current);
                return wallet.signTransaction({ ...tx, gas: gasLimit, gasPrice, nonce: latestNonce, type: "legacy" });
              },
              persist,
              broadcast: async (signedTransaction) => {
                if (stopping) throw new KeeperSigningStopped("The keeper stopped before broadcasting; the signed transaction journal is retained.");
                return client.sendRawTransaction({ serializedTransaction: signedTransaction });
              },
              confirm: async (journal) => {
                console.log(JSON.stringify({ task: task.id, state: "submitted", hash: journal.hash }));
                await client.waitForTransactionReceipt({ hash: journal.hash, confirmations: 2, timeout: 60_000 });
                return reconcile(journal);
              },
            });
            console.log(JSON.stringify({ task: task.id, state: confirmed.status === "confirmed" ? "confirmed" : "reverted_waiting", hash: confirmed.hash, blockNumber: confirmed.blockNumber }));
            // A resolved revert is budgeted for this task only. Other verified
            // tasks continue; unknown outcomes still fail-stop all signing.
          } catch (error) {
            if (error instanceof KeeperSigningStopped) { stopSigning(error); return; }
            console.log(JSON.stringify({ task: task.id, state: "skipped", reason: safeError(error) }));
          }
        }
      }
    } catch (error) {
      if (error instanceof KeeperSigningStopped) { stopSigning(error); return; }
      console.log(JSON.stringify({ state: "waiting", reason: safeError(error) }));
    }
    if (once || stopping) break;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { wakeWait = null; done(); }, Math.max(1000, 60_000 - (Date.now() - startedAt)));
      wakeWait = () => { clearTimeout(timer); wakeWait = null; done(); };
      if (stopping) wakeWait();
    });
  } while (!stopping); } finally { await releaseJournalLock?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runKeeper().catch((error) => {
    console.error(redactKeeperError(error, [process.env.MUSEGOD_KEEPER_PRIVATE_KEY, process.env.MUSEGOD_DEPLOY_PRIVATE_KEY, process.env.EVM_DY, process.env.ALCHEMY_API_KEY, process.env.ROBINHOOD_RPC_URL, process.env.FORK_RPC_URL]));
    process.exitCode = 1;
  });
}
