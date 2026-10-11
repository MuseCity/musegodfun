import type { Address, Hex } from "viem";
import { assertVaultAmount, assertVaultBlock, compareVaultEvents, vaultEventId, type VaultEventCursor, type VaultLedgerBlock } from "./buyback-vault-ledger";
import type { BaseNativeRelayEvidence } from "./base-buyback";

export type CustodyLedgerId = "base_automation" | "robinhood_treasury";
/** Amounts are in this event's asset precision. A fragment never crosses assets without a proved conversion. */
export type CustodyFragment = { batchId: string | null; amount: string };
export type CustodyEvidence =
  { kind: "adapter_release"; collector: Address; releaseLogIndex: number; transactionHash: Hex; blockHash: Hex } |
  { kind: "native_relay"; relay: BaseNativeRelayEvidence; sourceRevision: number; sourceEventId: string };
export type CustodyEvent = VaultEventCursor & { id: string; blockHash: Hex; transactionHash: Hex; asset: Address;
  kind: "in" | "out"; from: Address; to: Address; amount: string; nativeRequestMetadata?: Hex;
  /** Captured only from this movement's canonical successful transaction receipt; legacy rows may omit them. */
  nativeTransactionFrom?: Address; nativeTransactionTo?: Address; fragments?: CustodyFragment[]; evidence?: CustodyEvidence };
export type CustodyState = { version: 1; id: CustodyLedgerId; chainId: 8453 | 4663; account: Address; revision: number;
  checkpoint: VaultLedgerBlock; cursor: VaultLedgerBlock; openingBalances: Record<string, string>; observedBalances: Record<string, string>;
  updatedAt: number; blockedReason: string | null; assetErrors?: Record<string,string>; releasedAssets?: Address[]; assetCursors?: Record<string,VaultLedgerBlock>; assetBackfillAt?: Record<string,number> };
export type CustodyCommit = { expectedRevision: number; state: CustodyState; blocks: VaultLedgerBlock[]; events: CustodyEvent[];
  rollbackAfterBlock?: string; classifications?: { eventId: string; fragments: CustodyFragment[]; evidence: CustodyEvidence; revalidate?: boolean }[] };
export type CustodyConsumption = { eventId: string; asset: Address; amount: string; fragments: CustodyFragment[] };
export type CustodyReport = { id: CustodyLedgerId; ready: boolean; caughtUp: boolean; fresh: boolean; lagBlocks: string; maxLagBlocks: string; reason: string | null; revision: number;
  checkpointBlock: string | null; indexedThrough: string | null; confirmedThrough: string; consumptions: CustodyConsumption[];
  /** Balance/FIFO readiness is independent of currently withheld source attribution. Original proofs remain stored. */
  withheldEventIds: string[];
  assets: { asset: Address; ready: boolean; reason: string | null; received: string; pending: string; baseReceived: string; basePending: string }[] };
const address = /^0x[\da-f]{40}$/i, hash = /^0x[\da-f]{64}$/i;
export function assertCustodyFragments(fragments: CustodyFragment[], amount: string) {
  assertVaultAmount(amount);
  if (!Array.isArray(fragments) || !fragments.length) throw new Error("Missing custody fragments");
  for (const fragment of fragments) {
    assertVaultAmount(fragment.amount);
    if (BigInt(fragment.amount) === 0n || fragment.batchId !== null && (typeof fragment.batchId !== "string" || !fragment.batchId.length || fragment.batchId.length > 200))
      throw new Error("Invalid custody fragment");
  }
  if (fragments.reduce((sum, row) => sum + BigInt(row.amount), 0n) !== BigInt(amount)) throw new Error("Custody fragments do not conserve funds");
}
export function assertCustodyEvent(event: CustodyEvent, state: CustodyState) {
  assertVaultAmount(event.blockNumber); assertVaultAmount(event.amount);
  if (!hash.test(event.blockHash) || !hash.test(event.transactionHash) || !address.test(event.asset) || !address.test(event.from) || !address.test(event.to) ||
    !Number.isSafeInteger(event.transactionIndex) || event.transactionIndex < 0 || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0 ||
    event.id !== vaultEventId(event.transactionHash, event.logIndex) || !["in", "out"].includes(event.kind) ||
    (event.kind === "in" ? event.to : event.from).toLowerCase() !== state.account.toLowerCase())
    throw new Error("Invalid canonical custody event");
  if(event.nativeTransactionFrom!==undefined&&!address.test(event.nativeTransactionFrom)||event.nativeTransactionTo!==undefined&&!address.test(event.nativeTransactionTo))throw new Error("Invalid canonical custody transaction context");
  if (event.fragments) {
    if (event.kind !== "in" || !event.evidence) throw new Error("Custody provenance requires incoming canonical evidence");
    assertCustodyFragments(event.fragments, event.amount);
  }
}
export function assertCustodyState(state: CustodyState) {
  if (state.version !== 1 || !["base_automation", "robinhood_treasury"].includes(state.id) ||
    state.chainId !== (state.id === "base_automation" ? 8453 : 4663) || !address.test(state.account) || !Number.isSafeInteger(state.revision) || state.revision < 1)
    throw new Error("Invalid custody journal state");
  assertVaultBlock(state.checkpoint); assertVaultBlock(state.cursor);
  if (BigInt(state.cursor.number) < BigInt(state.checkpoint.number)) throw new Error("Custody cursor precedes checkpoint");
  for(const [asset,cursor] of Object.entries(state.assetCursors??{})){if(!address.test(asset)||asset!==asset.toLowerCase())throw new Error("Invalid custody asset cursor");assertVaultBlock(cursor);if(BigInt(cursor.number)<BigInt(state.checkpoint.number)||BigInt(cursor.number)>BigInt(state.cursor.number))throw new Error("Custody asset cursor outside journal");}
  for (const balances of [state.openingBalances, state.observedBalances]) for (const [asset, amount] of Object.entries(balances)) {
    if (!address.test(asset) || asset !== asset.toLowerCase()) throw new Error("Invalid custody balance asset");
    assertVaultAmount(amount);
  }
}
export function assertCustodyCommit(input: CustodyCommit, previous: CustodyState | null) {
  assertCustodyState(input.state);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.state.revision !== input.expectedRevision + 1 ||
    (previous?.revision ?? 0) !== input.expectedRevision) throw new Error("Custody revision changed; retry");
  if (previous) {
    if (previous.id !== input.state.id || previous.chainId !== input.state.chainId || previous.account.toLowerCase() !== input.state.account.toLowerCase() ||
      JSON.stringify(previous.checkpoint) !== JSON.stringify(input.state.checkpoint)) throw new Error("Custody checkpoint or graph cannot be replaced");
    for (const [asset, amount] of Object.entries(previous.openingBalances)) if (input.state.openingBalances[asset] !== amount) throw new Error("Custody opening balance cannot be replaced");
  }
  if (input.rollbackAfterBlock !== undefined) {
    assertVaultAmount(input.rollbackAfterBlock);
    if (!previous || BigInt(input.rollbackAfterBlock) < BigInt(previous.checkpoint.number) || BigInt(input.rollbackAfterBlock) > BigInt(previous.cursor.number))
      throw new Error("Invalid custody rollback ancestor");
  }
  for (const block of input.blocks) assertVaultBlock(block);
  for (const event of input.events) {
    assertCustodyEvent(event, input.state);
    if (BigInt(event.blockNumber) <= BigInt(input.state.checkpoint.number) || BigInt(event.blockNumber) > BigInt(input.state.cursor.number)) throw new Error("Custody event outside journal interval");
  }
}
export function emptyCustodyReport(id: CustodyLedgerId, head = 0n, reason = "Custody checkpoint has not been established"): CustodyReport {
  return { id, ready: false, caughtUp: false, fresh: false, lagBlocks: String(head), maxLagBlocks: String(custodyMaxLag(id)), reason, revision: 0, checkpointBlock: null, indexedThrough: null, confirmedThrough: String(head), consumptions: [], assets: [],withheldEventIds:[] };
}
export function custodyMaxLag(id: CustodyLedgerId) { return id === "base_automation" ? 30n : 600n; }
/** Every outgoing transfer, including unrelated spending, consumes FIFO. Opening/donated funds remain unknown. */
export function replayCustodyLedger(state: CustodyState, input: CustodyEvent[], head: bigint): CustodyReport {
  assertCustodyState(state);
  const report = { ...emptyCustodyReport(state.id, head), revision: state.revision, checkpointBlock: state.checkpoint.number,
    indexedThrough: state.cursor.number, caughtUp: BigInt(state.cursor.number) === head,
    lagBlocks: String(head > BigInt(state.cursor.number) ? head - BigInt(state.cursor.number) : 0n),
    fresh: BigInt(state.cursor.number) <= head && head - BigInt(state.cursor.number) <= custodyMaxLag(state.id) };
  type Lot = { batchId: string | null; remaining: bigint };
  const queues = new Map<string, Lot[]>(), received = new Map<string, bigint>(), baseReceived = new Map<string, bigint>();
  for (const [asset, amount] of Object.entries(state.openingBalances)) queues.set(asset, BigInt(amount) ? [{ batchId: null, remaining: BigInt(amount) }] : []);
  for(const asset of [...Object.keys(state.observedBalances),...Object.keys(state.assetErrors??{})])if(!queues.has(asset))queues.set(asset,[]);
  let failure = state.blockedReason; const assetFailures = new Map(Object.entries(state.assetErrors ?? {}));
  for(const [asset,cursor] of Object.entries(state.assetCursors??{}))if(BigInt(cursor.number)<BigInt(state.cursor.number))assetFailures.set(asset,"Asset transfer backfill is pending; attribution withheld");
  const seen = new Set<string>();
  for (const event of [...input].sort(compareVaultEvents)) {
    assertCustodyEvent(event, state);
    if (event.amount === "0" || event.from.toLowerCase() === event.to.toLowerCase()) continue;
    if (seen.has(event.id)) throw new Error("Duplicate custody event"); seen.add(event.id);
    if (BigInt(event.blockNumber) <= BigInt(state.checkpoint.number) || BigInt(event.blockNumber) > BigInt(state.cursor.number)) throw new Error("Custody event outside journal interval");
    const asset = event.asset.toLowerCase(), queue = queues.get(asset) ?? [], amount = BigInt(event.amount);
    if (!Object.hasOwn(state.openingBalances, asset)) assetFailures.set(asset,"Custody asset lacks a canonical opening balance");
    queues.set(asset, queue);
    if (event.kind === "in") {
      const fragments = event.fragments ?? (amount ? [{ batchId: null, amount: event.amount }] : []);
      for (const fragment of fragments) queue.push({ batchId: fragment.batchId, remaining: BigInt(fragment.amount) });
      received.set(asset, (received.get(asset) ?? 0n) + amount);
      baseReceived.set(asset, (baseReceived.get(asset) ?? 0n) + fragments.filter(row => row.batchId).reduce((sum, row) => sum + BigInt(row.amount), 0n));
    } else {
      let remaining = amount; const fragments: CustodyFragment[] = [];
      for (const lot of queue) {
        if (!remaining) break;
        const take = lot.remaining < remaining ? lot.remaining : remaining;
        if (take) { fragments.push({ batchId: lot.batchId, amount: String(take) }); lot.remaining -= take; remaining -= take; }
      }
      if (remaining) assetFailures.set(asset,"Custody outflow exceeds indexed balance; attribution withheld");
      report.consumptions.push({ eventId: event.id, asset: event.asset, amount: event.amount, fragments });
    }
  }
  for (const [asset, queue] of queues) {
    const pending = queue.reduce((sum, row) => sum + row.remaining, 0n);
    if (state.observedBalances[asset] === undefined || pending !== BigInt(state.observedBalances[asset])) assetFailures.set(asset,"Custody balance does not reconcile");
    report.assets.push({ asset: asset as Address, ready: !assetFailures.has(asset), reason: assetFailures.get(asset) ?? null, received: String(received.get(asset) ?? 0n), pending: String(pending), baseReceived: String(baseReceived.get(asset) ?? 0n),
      basePending: String(queue.filter(row => row.batchId).reduce((sum, row) => sum + row.remaining, 0n)) });
  }
  report.consumptions = report.consumptions.filter(row => !assetFailures.has(row.asset.toLowerCase()));
  report.assets = report.assets.map(row => assetFailures.has(row.asset.toLowerCase()) ? {...row,baseReceived:"0",basePending:"0"} : row);
  report.ready = !failure && report.assets.some(row => row.ready); report.reason = failure ?? (report.ready ? null : [...assetFailures.values()][0] ?? "No verified custody assets");
  if (failure) { report.consumptions = []; report.assets = report.assets.map(row => ({ ...row, baseReceived: "0", basePending: "0" })); }
  return report;
}
/** Converts consumed input fragments to actual output precision; cumulative rounding preserves all output, including unknown funds. */
export function convertCustodyFragments(input: CustodyFragment[], amountIn: string, amountOut: string): CustodyFragment[] {
  assertCustodyFragments(input, amountIn); assertVaultAmount(amountOut);
  if (BigInt(amountIn) === 0n) throw new Error("Cannot allocate zero input");
  let cumulative = 0n, distributed = 0n; const output: CustodyFragment[] = [];
  for (const fragment of input) {
    cumulative += BigInt(fragment.amount); const allocation = BigInt(amountOut) * cumulative / BigInt(amountIn) - distributed; distributed += allocation;
    if (allocation) output.push({ batchId: fragment.batchId, amount: String(allocation) });
  }
  if (distributed !== BigInt(amountOut)) throw new Error("Conversion fragments do not conserve output");
  return output;
}
