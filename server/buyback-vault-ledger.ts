import { decodeEventLog, erc20Abi, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { assertVaultBaseFill, emptyVaultLedgerReport, replayVaultLedger, vaultEventId, type VaultLedgerBlock,
  type VaultLedgerCommit, type VaultLedgerEvent, type VaultLedgerState, type VaultEventCursor,
  type VaultBaseFillEvidence, type VaultLedgerReport } from "../src/lib/buyback-vault-ledger";

export type VaultLedgerStore = {
  vaultLedgerState(): VaultLedgerState | null | Promise<VaultLedgerState | null>;
  vaultLedgerEventPage(limit?: number, after?: VaultEventCursor): VaultLedgerEvent[] | Promise<VaultLedgerEvent[]>;
  vaultLedgerBlockPage(limit?: number, before?: string): VaultLedgerBlock[] | Promise<VaultLedgerBlock[]>;
  commitVaultLedger(input: VaultLedgerCommit): VaultLedgerState | Promise<VaultLedgerState>;
};
type LedgerClient = Pick<PublicClient, "getBlockNumber" | "getBlock" | "getLogs" | "getTransactionReceipt" | "readContract">;
const vaultAbi = parseAbi([
  "function totalSpent() view returns (uint256)", "function totalBurned() view returns (uint256)",
  "event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const executionEvent = parseAbiItem("event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)");
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export type VaultLedgerOptions = {
  vault: Address; weth: Address; swapper: Address; engineForwarders?: Address[];
  confirmations?: bigint; maxBlocks?: number;
  /** Private host scans may prove empty ranges using guarded canonical boundary headers. */
  fastEmptyRanges?: boolean;
  verifyBaseFill?: (event: VaultLedgerEvent, evidence: VaultBaseFillEvidence) => Promise<boolean>;
  /** Rebuild current native FIFO fragments without discarding healthy lots in a shared transfer. Read projection only. */
  resolveBaseFill?: (event: VaultLedgerEvent) => Promise<VaultBaseFillEvidence | null>;
};

/** The Robinhood worker owns this journal. Base consumers use its report, never a second Base-scoped ledger. */
export class VaultLedgerService {
  private readonly confirmations: bigint;
  private readonly maxBlocks: number;
  constructor(private readonly store: VaultLedgerStore, private readonly client: LedgerClient, private readonly options: VaultLedgerOptions) {
    this.confirmations = options.confirmations ?? 64n;
    this.maxBlocks = options.maxBlocks ?? 1000;
    if (this.confirmations < 1n || !Number.isSafeInteger(this.maxBlocks) || this.maxBlocks < 1 || this.maxBlocks > (options.fastEmptyRanges === true ? 10_000 : 1000))
      throw new Error("Invalid vault ledger confirmation or scan bound");
  }
  private async confirmedHead() {
    const head = await this.client.getBlockNumber();
    return head > this.confirmations ? head - this.confirmations : 0n;
  }
  private async block(number: bigint): Promise<VaultLedgerBlock> {
    const block = await this.client.getBlock({ blockNumber: number });
    if (!block.hash || block.number !== number) throw new Error("Vault block is not canonical");
    return { number: String(number), hash: block.hash, parentHash: block.parentHash };
  }
  private assertGraph(state: VaultLedgerState) {
    if (!equal(state.vault, this.options.vault) || !equal(state.weth, this.options.weth) || !equal(state.swapper, this.options.swapper))
      throw new Error("Vault ledger graph differs from runtime configuration");
  }
  private async balances(number: bigint, requireBigInts = false) {
    const [balance, spent, burned] = await Promise.all([
      this.client.readContract({ address: this.options.weth, abi: erc20Abi, functionName: "balanceOf", args: [this.options.vault], blockNumber: number }),
      this.client.readContract({ address: this.options.vault, abi: vaultAbi, functionName: "totalSpent", blockNumber: number }),
      this.client.readContract({ address: this.options.vault, abi: vaultAbi, functionName: "totalBurned", blockNumber: number }),
    ]);
    if (requireBigInts && [balance, spent, burned].some(value => typeof value !== "bigint" || value < 0n))
      throw new Error("Invalid canonical Vault balance or execution total");
    return { observedBalance: String(balance), observedTotalSpent: String(spent), observedTotalBurned: String(burned) };
  }
  private async events(deadline=Infinity) {
    const events: VaultLedgerEvent[] = [];
    let cursor: VaultEventCursor | undefined;
    for (;;) {
      if(Date.now()>=deadline)throw new Error("Vault maintenance budget reached; pending");
      const page = await this.store.vaultLedgerEventPage(500, cursor);
      events.push(...page);
      if (page.length < 500) return events;
      const last = page.at(-1)!;
      cursor = { blockNumber: last.blockNumber, transactionIndex: last.transactionIndex, logIndex: last.logIndex };
    }
  }
  async establishCheckpoint(preBaseDepositGuard: () => boolean | Promise<boolean>): Promise<VaultLedgerReport> {
    if (await this.store.vaultLedgerState()) return this.read();
    if (!await preBaseDepositGuard()) throw new Error("Checkpoint requires verified pre-Base-deposit state");
    const head = await this.confirmedHead(), block = await this.block(head), observed = await this.balances(head);
    if (!equal((await this.block(head)).hash, block.hash) || !await preBaseDepositGuard()) throw new Error("Pre-deposit checkpoint changed during collection");
    const { vault, weth, swapper } = this.options;
    const state: VaultLedgerState = { version: 1, chainId: 4663, vault, weth, swapper, revision: 1,
      checkpoint: { ...block, wethBalance: observed.observedBalance, totalSpent: observed.observedTotalSpent,
        totalBurned: observed.observedTotalBurned, establishedAt: Date.now() }, cursor: block,
      ...observed, updatedAt: Date.now(), blockedReason: null };
    await this.store.commitVaultLedger({ expectedRevision: 0, state, blocks: [block], events: [] });
    return this.read();
  }
  async read(deadline=Infinity): Promise<VaultLedgerReport> {
    if(Date.now()>=deadline)return emptyVaultLedgerReport(0n,"Vault maintenance budget reached; pending");
    const head = await this.confirmedHead(), state = await this.store.vaultLedgerState();
    if (!state) return emptyVaultLedgerReport(head);
    this.assertGraph(state);
    if(BigInt(state.cursor.number)>head)return {...emptyVaultLedgerReport(head,"Vault RPC is behind the indexed cursor; pending canonical verification"),initialized:true,checkpointBlock:state.checkpoint.number,indexedThrough:state.cursor.number};
    const canonical = equal((await this.block(BigInt(state.cursor.number))).hash, state.cursor.hash);
    if (!canonical) return { ...emptyVaultLedgerReport(head, "Vault journal reorg or confirmation rollback; reconciliation is required"), initialized: true,
      checkpointBlock: state.checkpoint.number, indexedThrough: state.cursor.number };
    const events = await this.events(deadline),projected:VaultLedgerEvent[]=[];
    for (const event of events) {if(Date.now()>=deadline)return emptyVaultLedgerReport(head,"Vault maintenance budget reached; pending");
      if(event.kind!=="weth_in"||event.source!=="base"){projected.push(event);continue;}
      let evidence:VaultBaseFillEvidence|null=null;
      try{
        if(this.options.resolveBaseFill)evidence=await this.options.resolveBaseFill(event);
        else if(this.options.verifyBaseFill&&await this.options.verifyBaseFill(event,event.baseFill!))evidence=event.baseFill!;
        if(evidence)assertVaultBaseFill(event,evidence,state);
      }catch{evidence=null;}
      // Failed source proof withholds only this lot's attribution. The canonical
      // WETH movement must still consume FIFO and reconcile real executions.
      projected.push(evidence?{...event,baseFill:evidence}:{...event,source:"unknown",baseFill:undefined});
    }
    // A CAS prevents a read from combining an old cursor with newly appended/rolled-back rows.
    const after = await this.store.vaultLedgerState();
    if (after?.revision !== state.revision) return { ...emptyVaultLedgerReport(head, "Vault journal changed during read; retry"), initialized: true };
    if (!equal((await this.block(BigInt(state.cursor.number))).hash, state.cursor.hash))
      return { ...emptyVaultLedgerReport(head, "Vault journal changed chain during read; reconcile"), initialized: true };
    return replayVaultLedger(state, projected, head);
  }
  private async commonAncestor(state: VaultLedgerState, head: bigint,deadline=Infinity): Promise<VaultLedgerBlock | null> {
    let ancestor:VaultLedgerBlock|null=null;
    if(equal((await this.block(BigInt(state.checkpoint.number))).hash,state.checkpoint.hash))ancestor=state.checkpoint;
    let lower=BigInt(state.cursor.number)-4095n>BigInt(state.checkpoint.number)+1n?BigInt(state.cursor.number)-4095n:BigInt(state.checkpoint.number)+1n,upper=BigInt(state.cursor.number)<head?BigInt(state.cursor.number):head;
    while(lower<=upper){if(Date.now()>=deadline)throw new Error("Vault maintenance budget reached; pending");const middle=(lower+upper)/2n,candidate=(await this.store.vaultLedgerBlockPage(1,String(middle+1n)))[0];
      if(!candidate||BigInt(candidate.number)<lower){lower=middle+1n;continue;}
      if(equal((await this.block(BigInt(candidate.number))).hash,candidate.hash)){ancestor=candidate;lower=middle+1n;}else upper=middle-1n;
    }
    return ancestor;
  }
  async reconcile(maxDurationMs = 45_000): Promise<VaultLedgerReport> {
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0 || maxDurationMs > 60_000) throw new Error("Invalid vault maintenance time budget");
    const deadline = Date.now() + maxDurationMs;
    const head = await this.confirmedHead();
    let state = await this.store.vaultLedgerState();
    try {
    if (!state) return emptyVaultLedgerReport(head);
    this.assertGraph(state);
    if(BigInt(state.cursor.number)>head)return {...emptyVaultLedgerReport(head,"Vault RPC is behind the indexed cursor; pending canonical verification"),initialized:true,checkpointBlock:state.checkpoint.number,indexedThrough:state.cursor.number};
    if (!equal((await this.block(BigInt(state.cursor.number))).hash, state.cursor.hash)) {
      const ancestor = await this.commonAncestor(state, head,deadline);
      if(Date.now()>=deadline)return emptyVaultLedgerReport(head,"Vault maintenance budget reached; pending");
      if (!ancestor || BigInt(ancestor.number) < BigInt(state.checkpoint.number)) {
        const blocked = { ...state, revision: state.revision + 1, updatedAt: Date.now(), blockedReason: "Vault checkpoint was reorganized; audited checkpoint recovery is required" };
        await this.store.commitVaultLedger({ expectedRevision: state.revision, state: blocked, blocks: [], events: [] });
        return this.read();
      }
      const observed = await this.balances(BigInt(ancestor.number));
      if(Date.now()>=deadline)return emptyVaultLedgerReport(head,"Vault maintenance budget reached; pending");
      state = await this.store.commitVaultLedger({ expectedRevision: state.revision,
        state: { ...state, cursor: ancestor, ...observed, revision: state.revision + 1, updatedAt: Date.now(), blockedReason: null },
        blocks: [], events: [], rollbackAfterBlock: ancestor.number });
    }
    let scanned = 0;
    // Finish and atomically commit a canonical page before yielding. Transport
    // timeouts can overrun the soft deadline; never abandon or partly commit it.
    while (BigInt(state.cursor.number) < head && scanned < this.maxBlocks && !state.blockedReason && Date.now() < deadline) {
      const from = BigInt(state.cursor.number) + 1n;
      if (this.options.fastEmptyRanges === true) {
        const count = Math.min(1000, this.maxBlocks - scanned);
        const to = from + BigInt(count - 1) < head ? from + BigInt(count - 1) : head;
        const [anchor, first, before] = await Promise.all([this.block(BigInt(state.cursor.number)), this.block(from), this.block(to)]);
        if (!equal(anchor.hash, state.cursor.hash) || !equal(first.parentHash, anchor.hash))
          throw new Error("Vault empty range anchor changed during collection");
        if (Date.now() >= deadline) break;
        let empty = false;
        try {
          const logs = await Promise.all([
            this.client.getLogs({ address: this.options.weth, event: transferEvent, args: { to: this.options.vault }, fromBlock: from, toBlock: to, strict: true }),
            this.client.getLogs({ address: this.options.weth, event: transferEvent, args: { from: this.options.vault }, fromBlock: from, toBlock: to, strict: true }),
            this.client.getLogs({ address: this.options.vault, event: executionEvent, fromBlock: from, toBlock: to, strict: true }),
          ]);
          empty = logs.every(rows => rows.length === 0);
        } catch { /* Unsupported wide log ranges retain the complete ordinary scan. */ }
        if (Date.now() >= deadline) break;
        if (empty) {
          const observed = await this.balances(to, true);
          if (observed.observedBalance === state.observedBalance && observed.observedTotalSpent === state.observedTotalSpent &&
            observed.observedTotalBurned === state.observedTotalBurned) {
            const [afterAnchor, afterFirst, afterEnd] = await Promise.all([this.block(BigInt(state.cursor.number)), this.block(from), this.block(to)]);
            if (!equal(afterAnchor.hash, anchor.hash) || !equal(afterFirst.hash, first.hash) || !equal(afterFirst.parentHash, anchor.hash) ||
              !equal(afterEnd.hash, before.hash)) throw new Error("Vault empty range changed before commit");
            if (Date.now() >= deadline) break;
            state = await this.store.commitVaultLedger({ expectedRevision: state.revision,
              state: { ...state, cursor: before, ...observed, revision: state.revision + 1, updatedAt: Date.now() },
              blocks: first.number === before.number ? [first] : [first, before], events: [] });
            scanned += Number(to - from + 1n);
            continue;
          }
        }
      }
      const count = Math.min(100, this.maxBlocks - scanned);
      const to = from + BigInt(count - 1) < head ? from + BigInt(count - 1) : head;
      const before = await this.block(to);
      const incoming: Awaited<ReturnType<LedgerClient["getLogs"]>> = [], outgoing: typeof incoming = [], executed: typeof incoming = [];
      // The existing RPC plan permits ten-block log ranges. A hundred-block
      // atomic page uses at most six such ranges (18 requests) concurrently.
      for (let start = from; start <= to; start += 60n) {
        const end = start + 59n < to ? start + 59n : to;
        const groups = await Promise.all(Array.from({ length: Number((end - start) / 10n) + 1 }, (_, index) => {
          const lower = start + BigInt(index) * 10n, upper = lower + 9n < end ? lower + 9n : end;
          return Promise.all([
            this.client.getLogs({ address: this.options.weth, event: transferEvent, args: { to: this.options.vault }, fromBlock: lower, toBlock: upper, strict: true }),
            this.client.getLogs({ address: this.options.weth, event: transferEvent, args: { from: this.options.vault }, fromBlock: lower, toBlock: upper, strict: true }),
            this.client.getLogs({ address: this.options.vault, event: executionEvent, fromBlock: lower, toBlock: upper, strict: true }),
          ]);
        }));
        incoming.push(...groups.flatMap(group => group[0])); outgoing.push(...groups.flatMap(group => group[1])); executed.push(...groups.flatMap(group => group[2]));
      }
      const blocks: VaultLedgerBlock[] = [];
      let parent = state.cursor.hash;
      // Twenty requests match the existing RPC HTTP batch size. Preserve
      // every header and verify ordered ancestry after each bounded group.
      for (let start = from; start <= to; start += 20n) {
        if(Date.now()>=deadline)throw new Error("Vault maintenance budget reached; pending");
        const end = start + 19n < to ? start + 19n : to;
        const group = await Promise.all(Array.from({ length: Number(end - start + 1n) }, (_, index) => this.block(start + BigInt(index))));
        for (const block of group) {
          if (!equal(block.parentHash, parent)) throw new Error("Vault journal block ancestry changed during collection");
          blocks.push(block); parent = block.hash;
        }
      }
      const blockHashes = new Map(blocks.map(b => [b.number, b.hash.toLowerCase()]));
      const events: VaultLedgerEvent[] = [];
      const receipts = new Map<Hex, Awaited<ReturnType<LedgerClient["getTransactionReceipt"]>>>();
      for (const log of [...incoming, ...outgoing, ...executed]) {
        if(Date.now()>=deadline)throw new Error("Vault maintenance budget reached; pending");
        if (log.removed || !log.transactionHash || !log.blockHash || log.blockNumber === null || log.logIndex === null || log.transactionIndex === null ||
          blockHashes.get(String(log.blockNumber)) !== log.blockHash.toLowerCase()) throw new Error("Noncanonical Vault log; retry later");
        if(equal(log.address,this.options.weth)){const decoded=decodeEventLog({abi:[transferEvent],data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});if(decoded.args.value===0n||equal(decoded.args.from,decoded.args.to))continue;}
        let receipt = receipts.get(log.transactionHash);
        if (!receipt) { receipt = await this.client.getTransactionReceipt({ hash: log.transactionHash }); receipts.set(log.transactionHash, receipt); }
        if (receipt.status !== "success" || !equal(receipt.blockHash, log.blockHash) || receipt.transactionIndex !== log.transactionIndex ||
          !receipt.logs.some(row => row.logIndex === log.logIndex && equal(row.address, log.address) && row.data === log.data && JSON.stringify(row.topics) === JSON.stringify(log.topics)))
          throw new Error("Vault log lacks a canonical successful receipt");
        const position = { id: vaultEventId(log.transactionHash, log.logIndex), blockNumber: String(log.blockNumber),
          blockHash: log.blockHash, transactionHash: log.transactionHash, transactionIndex: log.transactionIndex, logIndex: log.logIndex };
        if (equal(log.address, this.options.weth)) {
          const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
          if(decoded.args.value===0n||equal(decoded.args.from,decoded.args.to))continue;
          events.push(equal(decoded.args.to, this.options.vault)
            ? { ...position, kind: "weth_in", from: decoded.args.from, to: decoded.args.to, amount: String(decoded.args.value),
              source: this.options.engineForwarders?.some(a => equal(a, decoded.args.from)) ? "robinhood_engine" : "unknown" }
            : { ...position, kind: "weth_out", from: decoded.args.from, to: decoded.args.to, amount: String(decoded.args.value) });
        } else {
          const decoded = decodeEventLog({ abi: [executionEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
          events.push({ ...position, kind: "executed", caller: decoded.args.caller, wethAmount: String(decoded.args.wethAmount),
            museToDead: String(decoded.args.museToDead), profit: String(decoded.args.profit) });
        }
      }
      const observed = await this.balances(to);
      if (!equal((await this.block(to)).hash, before.hash) || !equal(blocks.at(-1)!.hash, before.hash)) throw new Error("Vault range changed during collection");
      if(Date.now()>=deadline)break;
      state = await this.store.commitVaultLedger({ expectedRevision: state.revision,
        state: { ...state, cursor: before, ...observed, revision: state.revision + 1, updatedAt: Date.now() }, blocks, events });
      scanned += Number(to - from + 1n);
    }
    return Date.now()>=deadline?emptyVaultLedgerReport(head,"Vault maintenance budget reached; pending"):await this.read(deadline);
    }catch(error){if(Date.now()>=deadline)return emptyVaultLedgerReport(head,"Vault maintenance budget reached; pending");throw error;}
  }
  async classifyBaseFill(eventId: string, evidence: VaultBaseFillEvidence, deadline=Infinity): Promise<VaultLedgerReport> {
    const state = await this.store.vaultLedgerState();
    if (!state) throw new Error("Vault checkpoint has not been established");
    this.assertGraph(state);
    const event = (await this.events(deadline)).find(row => row.id === eventId);
    if (!event) throw new Error("Vault transfer not indexed");
    assertVaultBaseFill(event, evidence, state);
    if (!this.options.verifyBaseFill || !await this.options.verifyBaseFill(event, evidence)) throw new Error("Base source batch and Across fill are not canonically verified");
    if (!equal((await this.block(BigInt(event.blockNumber))).hash, event.blockHash)) throw new Error("Base fill was reorganized; reconcile before classification");
    const revalidate=event.kind === "weth_in" && event.source === "base" && !!event.baseFill && !await this.options.verifyBaseFill(event,event.baseFill);
    if(Date.now()>=deadline)throw new Error("Vault maintenance budget reached; pending");
    await this.store.commitVaultLedger({ expectedRevision: state.revision,
      state: { ...state, revision: state.revision + 1, updatedAt: Date.now() }, blocks: [], events: [],
      classifications: [{ eventId, source: "base", baseFill: evidence,
        revalidate }] });
    return this.read(deadline);
  }
  async invalidateBaseFill(eventId:string,deadline=Infinity):Promise<VaultLedgerReport> {
    const state=await this.store.vaultLedgerState();if(!state)throw new Error("Vault checkpoint missing");this.assertGraph(state);
    const event=(await this.events(deadline)).find(row=>row.id===eventId);
    if(!event||event.kind!=="weth_in"||event.source!=="base"||!event.baseFill||!this.options.verifyBaseFill||await this.options.verifyBaseFill(event,event.baseFill))throw new Error("Canonical Base provenance cannot be invalidated");
    if(!equal((await this.block(BigInt(event.blockNumber))).hash,event.blockHash))throw new Error("Vault classification transfer reorg; reconcile first");
    if(Date.now()>=deadline)throw new Error("Vault maintenance budget reached; pending");
    await this.store.commitVaultLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,updatedAt:Date.now()},blocks:[],events:[],classifications:[{eventId,source:"unknown",revalidate:true}]});
    return this.read(deadline);
  }

}
