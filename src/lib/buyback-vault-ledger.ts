import type { Address, Hex } from "viem";
import { assertCustodyFragments, type CustodyFragment } from "./buyback-custody-ledger";

export type VaultLedgerBlock = { number: string; hash: Hex; parentHash: Hex };
export type VaultLedgerCheckpoint = VaultLedgerBlock & {
  wethBalance: string; totalSpent: string; totalBurned: string; establishedAt: number;
};
export type VaultSource = "base" | "robinhood_engine" | "donation" | "unknown";
/** Evidence is produced by the server's canonical source-batch/Across verifier, never a client declaration. */
export type VaultLegacyBaseFillEvidence = {
  batchId: string; sourceChainId: 8453; destinationChainId: 4663;
  sourceTransactionHash: Hex; sourceBlockHash: Hex; depositId: string;
  fillTransactionHash: Hex; fillBlockHash: Hex; fillLogIndex: number;
  recipient: Address; outputToken: Address; outputAmount: string;
  destinationImplementation?: { address: Address; runtimeHash: Hex; blockNumber: string; differsFromReviewed: boolean };
};
/** Native Relay is received into a shared Treasury. Only canonical Forwarder + Treasury FIFO can propagate its fragments. */
export type VaultNativeTreasuryEvidence = { protocol: "splits_native_relay_v1"; treasury: Address;
  treasuryEventId: string; treasuryRevision: number; fragments: CustodyFragment[];
  fillTransactionHash: Hex; fillBlockHash: Hex; fillLogIndex: number; recipient: Address; outputToken: Address; outputAmount: string };
export type VaultBaseFillEvidence = VaultLegacyBaseFillEvidence | VaultNativeTreasuryEvidence;
export function vaultFillFragments(evidence: VaultBaseFillEvidence): CustodyFragment[] {
  return "protocol" in evidence ? evidence.fragments : [{batchId:evidence.batchId,amount:evidence.outputAmount}];
}
type VaultLogPosition = {
  id: string; blockNumber: string; blockHash: Hex; transactionHash: Hex;
  transactionIndex: number; logIndex: number;
};
export type VaultLedgerEvent = VaultLogPosition & (
  { kind: "weth_in"; from: Address; to: Address; amount: string; source: VaultSource; baseFill?: VaultBaseFillEvidence } |
  { kind: "weth_out"; from: Address; to: Address; amount: string } |
  { kind: "executed"; caller: Address; wethAmount: string; museToDead: string; profit: string }
);
export type VaultLedgerState = {
  version: 1; chainId: 4663; vault: Address; weth: Address; swapper: Address;
  revision: number; checkpoint: VaultLedgerCheckpoint; cursor: VaultLedgerBlock;
  observedBalance: string; observedTotalSpent: string; observedTotalBurned: string;
  updatedAt: number; blockedReason: string | null;
};
export type VaultEventCursor = Pick<VaultLogPosition, "blockNumber" | "transactionIndex" | "logIndex">;
export type VaultLedgerCommit = {
  expectedRevision: number; state: VaultLedgerState; blocks: VaultLedgerBlock[];
  events: VaultLedgerEvent[]; rollbackAfterBlock?: string;
  classifications?: { eventId: string; source: VaultSource; baseFill?: VaultBaseFillEvidence; revalidate?: boolean }[];
};
export type VaultLedgerLot = {
  id: string; source: VaultSource; batchId: string | null; received: string; consumed: string;
  remaining: string; museToDead: string;
};
export type VaultLedgerAllocation = {
  executionId: string; lotId: string; source: VaultSource; batchId: string | null;
  wethAmount: string; museToDead: string;
};
export type VaultLedgerBatchSummary = {
  batchId: string; receivedWeth: string; spentWeth: string; pendingWeth: string;
  attributedMuseToDead: string; status: "pending_vault" | "partially_consumed" | "consumed";
};
export type VaultLedgerReport = {
  version: 1; initialized: boolean; caughtUp: boolean; attributionReady: boolean; reason: string | null;
  checkpointBlock: string | null; indexedThrough: string | null; confirmedThrough: string;
  baseReceivedWeth: string; baseSpentWeth: string; basePendingWeth: string; baseAttributedMuseToDead: string;
  totalExecutionWeth: string; totalMuseToDead: string; totalCallerProfit: string;
  lots: VaultLedgerLot[]; allocations: VaultLedgerAllocation[]; batches: VaultLedgerBatchSummary[];
};
const unsigned = /^(?:0|[1-9]\d*)$/;
const hash = /^0x[\da-f]{64}$/i;
const address = /^0x[\da-f]{40}$/i;
export function assertVaultAmount(value: unknown): asserts value is string {
  if (typeof value !== "string" || !unsigned.test(value)) throw new Error("Invalid raw vault amount");
}
export function assertVaultBlock(value: VaultLedgerBlock) {
  assertVaultAmount(value.number);
  if (!hash.test(value.hash) || !hash.test(value.parentHash)) throw new Error("Invalid vault block identity");
}
export function vaultEventId(transactionHash: Hex, logIndex: number) {
  return `${transactionHash.toLowerCase()}:${logIndex}`;
}
export function assertVaultEvent(event: VaultLedgerEvent) {
  assertVaultAmount(event.blockNumber);
  if (!hash.test(event.blockHash) || !hash.test(event.transactionHash) ||
    !Number.isSafeInteger(event.logIndex) || event.logIndex < 0 ||
    !Number.isSafeInteger(event.transactionIndex) || event.transactionIndex < 0 ||
    event.id !== vaultEventId(event.transactionHash, event.logIndex)) throw new Error("Invalid vault event identity");
  if (event.kind === "executed") {
    if (!address.test(event.caller)) throw new Error("Invalid vault execution caller");
    for (const value of [event.wethAmount, event.museToDead, event.profit]) assertVaultAmount(value);
  } else {
    if (!address.test(event.from) || !address.test(event.to)) throw new Error("Invalid vault transfer address");
    assertVaultAmount(event.amount);
    if (event.kind === "weth_in" && (!["base", "robinhood_engine", "donation", "unknown"].includes(event.source) ||
      (event.source === "base" && !event.baseFill))) throw new Error("Missing verified Base fill identity");
  }
}
export function assertVaultState(state: VaultLedgerState) {
  if (state.version !== 1 || state.chainId !== 4663 || ![state.vault, state.weth, state.swapper].every(a => address.test(a)) ||
    !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error("Invalid vault ledger state");
  assertVaultBlock(state.checkpoint); assertVaultBlock(state.cursor);
  for (const value of [state.checkpoint.wethBalance, state.checkpoint.totalSpent, state.checkpoint.totalBurned,
    state.observedBalance, state.observedTotalSpent, state.observedTotalBurned]) assertVaultAmount(value);
  if (BigInt(state.cursor.number) < BigInt(state.checkpoint.number)) throw new Error("Vault cursor precedes checkpoint");
}
export function assertVaultBaseFill(event: VaultLedgerEvent, evidence: VaultBaseFillEvidence, state: VaultLedgerState) {
  if (!evidence || event.kind !== "weth_in" || !Number.isSafeInteger(evidence.fillLogIndex) || evidence.fillLogIndex < 0 ||
    evidence.fillTransactionHash.toLowerCase() !== event.transactionHash.toLowerCase() || evidence.fillBlockHash.toLowerCase() !== event.blockHash.toLowerCase() ||
    evidence.recipient.toLowerCase() !== state.vault.toLowerCase() || evidence.outputToken.toLowerCase() !== state.weth.toLowerCase() || evidence.outputAmount !== event.amount)
    throw new Error("Base fill evidence does not match the canonical Vault transfer");
  assertVaultAmount(evidence.outputAmount);
  if ("protocol" in evidence) {
    if (evidence.protocol !== "splits_native_relay_v1" || !address.test(evidence.treasury) || evidence.treasury.toLowerCase() !== event.from.toLowerCase() ||
      evidence.treasuryEventId !== event.id || evidence.fillLogIndex !== event.logIndex || !Number.isSafeInteger(evidence.treasuryRevision) || evidence.treasuryRevision < 1)
      throw new Error("Invalid native Treasury propagation identity");
    assertCustodyFragments(evidence.fragments,event.amount);
    if (!evidence.fragments.some(fragment => fragment.batchId)) throw new Error("Native Treasury propagation contains no verified Base funds");
  } else {
    if (!evidence.batchId || evidence.batchId.length > 200 || evidence.sourceChainId !== 8453 || evidence.destinationChainId !== 4663 || !hash.test(evidence.sourceTransactionHash) || !hash.test(evidence.sourceBlockHash))
      throw new Error("Invalid historical Across fill identity");
    assertVaultAmount(evidence.depositId);
    if (evidence.destinationImplementation !== undefined) {
      const implementation = evidence.destinationImplementation;
      if (!implementation || typeof implementation !== "object") throw new Error("Invalid historical destination implementation identity");
      assertVaultAmount(implementation.blockNumber);
      if (!address.test(implementation.address) || !hash.test(implementation.runtimeHash) || typeof implementation.differsFromReviewed !== "boolean" || implementation.blockNumber !== event.blockNumber)
        throw new Error("Invalid historical destination implementation identity");
    }
  }
}
export function assertVaultCommit(input: VaultLedgerCommit, previous: VaultLedgerState | null) {
  assertVaultState(input.state);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
    input.state.revision !== input.expectedRevision + 1) throw new Error("Invalid vault ledger revision");
  if ((previous?.revision ?? 0) !== input.expectedRevision) throw new Error("Vault ledger revision changed; retry reconciliation");
  if (previous && (JSON.stringify(previous.checkpoint) !== JSON.stringify(input.state.checkpoint) ||
    previous.vault.toLowerCase() !== input.state.vault.toLowerCase() || previous.weth.toLowerCase() !== input.state.weth.toLowerCase() ||
    previous.swapper.toLowerCase() !== input.state.swapper.toLowerCase())) throw new Error("Vault checkpoint or graph cannot be replaced");
  if (input.rollbackAfterBlock !== undefined) {
    assertVaultAmount(input.rollbackAfterBlock);
    if (!previous || BigInt(input.rollbackAfterBlock) < BigInt(previous.checkpoint.number) ||
      BigInt(input.rollbackAfterBlock) > BigInt(previous.cursor.number)) throw new Error("Invalid vault rollback ancestor");
  }
  for (const block of input.blocks) assertVaultBlock(block);
  for (const event of input.events) {
    assertVaultEvent(event);
    if (BigInt(event.blockNumber) <= BigInt(input.state.checkpoint.number) || BigInt(event.blockNumber) > BigInt(input.state.cursor.number))
      throw new Error("Vault event outside indexed interval");
    if (event.kind === "weth_in" && event.source === "base") assertVaultBaseFill(event, event.baseFill!, input.state);
  }
}
export function compareVaultEvents(a: VaultEventCursor, b: VaultEventCursor) {
  const block = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  return block < 0n ? -1 : block > 0n ? 1 : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;
}
export function emptyVaultLedgerReport(confirmedThrough: bigint, reason = "Vault checkpoint has not been established"): VaultLedgerReport {
  return { version: 1, initialized: false, caughtUp: false, attributionReady: false, reason,
    checkpointBlock: null, indexedThrough: null, confirmedThrough: String(confirmedThrough),
    baseReceivedWeth: "0", baseSpentWeth: "0", basePendingWeth: "0", baseAttributedMuseToDead: "0",
    totalExecutionWeth: "0", totalMuseToDead: "0", totalCallerProfit: "0", lots: [], allocations: [], batches: [] };
}
/** Replays the complete journal. WETH transfers validate spend, Executed supplies burn/profit; spend is debited once. */
export function replayVaultLedger(state: VaultLedgerState, input: VaultLedgerEvent[], confirmedThrough: bigint): VaultLedgerReport {
  assertVaultState(state);
  const report = emptyVaultLedgerReport(confirmedThrough);
  Object.assign(report, { initialized: true, checkpointBlock: state.checkpoint.number, indexedThrough: state.cursor.number,
    caughtUp: BigInt(state.cursor.number) === confirmedThrough, reason: state.blockedReason });
  const events = [...input].sort(compareVaultEvents);
  const unique = new Set<string>();
  const lots: { value: VaultLedgerLot; remaining: bigint; consumed: bigint; burned: bigint }[] = [];
  const addLot = (id: string, source: VaultSource, amount: bigint, batchId: string | null) => {
    if (amount === 0n) return;
    lots.push({ value: { id, source, batchId, received: String(amount), consumed: "0", remaining: String(amount), museToDead: "0" }, remaining: amount, consumed: 0n, burned: 0n });
  };
  addLot(`opening:${state.checkpoint.number}`, "unknown", BigInt(state.checkpoint.wethBalance), null);
  let spent = 0n, burned = 0n, profit = 0n, incoming = 0n, fifo = 0;
  let failure = state.blockedReason;
  const spends = new Map<string, VaultLedgerEvent & { kind: "executed" }>();
  // Every outgoing transfer must match exactly one later Executed in the same transaction.
  const pending = new Map<string, (VaultLedgerEvent & { kind: "weth_out" })[]>();
  for (const event of events) {
    assertVaultEvent(event);
    if (unique.has(event.id)) throw new Error("Duplicate vault event in replay");
    unique.add(event.id);
    if (BigInt(event.blockNumber) <= BigInt(state.checkpoint.number) || BigInt(event.blockNumber) > BigInt(state.cursor.number)) throw new Error("Vault event outside indexed interval");
    if (event.kind === "weth_out") {
      if (event.from.toLowerCase() !== state.vault.toLowerCase() || event.to.toLowerCase() !== state.swapper.toLowerCase()) failure ||= "Unrecognized Vault WETH outflow";
      const queue = pending.get(event.transactionHash.toLowerCase()) || []; queue.push(event); pending.set(event.transactionHash.toLowerCase(), queue);
    } else if (event.kind === "executed") {
      const queue = pending.get(event.transactionHash.toLowerCase()) || [];
      const out = queue.shift();
      if (!out || out.amount !== event.wethAmount || out.blockHash !== event.blockHash) failure ||= "Vault execution does not match its canonical WETH transfer";
      else spends.set(out.id, event);
    }
  }
  if ([...pending.values()].some(queue => queue.length)) failure ||= "Unmatched Vault WETH outflow";
  for (const event of events) {
    if (event.kind === "weth_in") {
      if (event.to.toLowerCase() !== state.vault.toLowerCase()) throw new Error("Invalid Vault incoming recipient");
      if (event.source === "base") assertVaultBaseFill(event, event.baseFill!, state);
      const amount = BigInt(event.amount); incoming += amount;
      if (event.source === "base") {
        const fragments=vaultFillFragments(event.baseFill!);
        for (const [index,fragment] of fragments.entries()) addLot("protocol" in event.baseFill! ? `${event.id}#${index}` : event.id,fragment.batchId ? "base" : "unknown",BigInt(fragment.amount),fragment.batchId);
      } else addLot(event.id,event.source,amount,null);
    } else if (event.kind === "weth_out") {
      const execution = spends.get(event.id);
      if (!execution) continue;
      const amount = BigInt(execution.wethAmount), muse = BigInt(execution.museToDead);
      if (amount === 0n || muse === 0n) { failure ||= "Invalid zero Vault execution"; continue; }
      let remaining = amount, cumulative = 0n, distributed = 0n;
      while (remaining > 0n && fifo < lots.length) {
        const lot = lots[fifo];
        if (lot.remaining === 0n) { fifo++; continue; }
        const take = remaining < lot.remaining ? remaining : lot.remaining;
        cumulative += take;
        const cumulativeBurn = muse * cumulative / amount, share = cumulativeBurn - distributed;
        distributed = cumulativeBurn; lot.remaining -= take; lot.consumed += take; lot.burned += share; remaining -= take;
        report.allocations.push({ executionId: execution.id, lotId: lot.value.id, source: lot.value.source, batchId: lot.value.batchId,
          wethAmount: String(take), museToDead: String(share) });
      }
      if (remaining !== 0n) failure ||= "Unknown Vault WETH shortfall; attribution is withheld";
      spent += amount; burned += muse; profit += BigInt(execution.profit);
    }
  }
  if (BigInt(state.checkpoint.wethBalance) + incoming - spent !== BigInt(state.observedBalance) ||
    BigInt(state.checkpoint.totalSpent) + spent !== BigInt(state.observedTotalSpent) ||
    BigInt(state.checkpoint.totalBurned) + burned !== BigInt(state.observedTotalBurned)) failure ||= "Vault balance or execution totals do not reconcile";
  report.lots = lots.map(lot => ({ ...lot.value, consumed: String(lot.consumed), remaining: String(lot.remaining), museToDead: String(lot.burned) }));
  report.totalExecutionWeth = String(spent); report.totalMuseToDead = String(burned); report.totalCallerProfit = String(profit);
  const batches = new Map<string, { received: bigint; spent: bigint; pending: bigint; burned: bigint }>();
  for (const lot of lots) if (lot.value.source === "base" && lot.value.batchId) {
    const row = batches.get(lot.value.batchId) || { received: 0n, spent: 0n, pending: 0n, burned: 0n };
    row.received += BigInt(lot.value.received); row.spent += lot.consumed; row.pending += lot.remaining; row.burned += lot.burned;
    batches.set(lot.value.batchId, row);
  }
  report.baseReceivedWeth = String([...batches.values()].reduce((sum, b) => sum + b.received, 0n));
  report.baseSpentWeth = String([...batches.values()].reduce((sum, b) => sum + b.spent, 0n));
  report.basePendingWeth = String([...batches.values()].reduce((sum, b) => sum + b.pending, 0n));
  report.baseAttributedMuseToDead = String([...batches.values()].reduce((sum, b) => sum + b.burned, 0n));
  report.batches = [...batches].map(([batchId, b]) => ({ batchId, receivedWeth: String(b.received), spentWeth: String(b.spent),
    pendingWeth: String(b.pending), attributedMuseToDead: String(b.burned), status: b.pending === 0n ? "consumed" : b.spent === 0n ? "pending_vault" : "partially_consumed" }));
  // FIFO attribution describes checkpoint -> indexedThrough, which has been
  // completely reconciled. New blocks change caughtUp/confirmedThrough, never
  // erase verified historical burns or add unindexed executions to them.
  report.reason = failure || null;
  report.attributionReady = !failure;
  if (!report.attributionReady) {
    report.baseAttributedMuseToDead = "0";
    report.allocations = [];
    report.batches = report.batches.map(b => ({ ...b, attributedMuseToDead: "0" }));
    report.lots = report.lots.map(lot => ({ ...lot, museToDead: "0" }));
  }
  return report;
}
