import { decodeEventLog, erc20Abi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { emptyCustodyReport, replayCustodyLedger, type CustodyCommit, type CustodyEvent, type CustodyEvidence, type CustodyFragment,
  type CustodyLedgerId, type CustodyReport, type CustodyState } from "../src/lib/buyback-custody-ledger";
import { vaultEventId, type VaultEventCursor, type VaultLedgerBlock } from "../src/lib/buyback-vault-ledger";
export type CustodyLedgerStore = {
  custodyLedgerState(id: CustodyLedgerId): CustodyState | null | Promise<CustodyState | null>;
  custodyLedgerEventPage(id: CustodyLedgerId, limit?: number, after?: VaultEventCursor): CustodyEvent[] | Promise<CustodyEvent[]>;
  custodyLedgerBlockPage(id: CustodyLedgerId, limit?: number, before?: string): VaultLedgerBlock[] | Promise<VaultLedgerBlock[]>;
  commitCustodyLedger(input: CustodyCommit): CustodyState | Promise<CustodyState>;
};
type Client = Pick<PublicClient, "getChainId" | "getBlockNumber" | "getBlock" | "getLogs" | "getTransactionReceipt" | "readContract">;
const nativeMovement = parseAbiItem("event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)");
const transfer = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export type CustodyOptions = { id: CustodyLedgerId; account: Address; initialAssets: Address[]; confirmations?: bigint; maxBlocks?: number;
  /** Canonical verifier, never a browser-provided amount. Called on every attributed read, including after restart/reorg. */
  verifyEvidence?: (event: CustodyEvent, evidence: CustodyEvidence, fragments: CustodyFragment[]) => Promise<boolean> };
export async function readAllCustodyEvents(store: CustodyLedgerStore, id: CustodyLedgerId) {
  const output: CustodyEvent[] = []; let after: VaultEventCursor | undefined;
  for (;;) {
    const page = await store.custodyLedgerEventPage(id,500,after); output.push(...page);
    if (page.length < 500) return output;
    const last = page.at(-1)!; const cursor = {blockNumber:last.blockNumber,transactionIndex:last.transactionIndex,logIndex:last.logIndex};
    if (JSON.stringify(after) === JSON.stringify(cursor)) throw new Error("Custody pagination did not advance"); after = cursor;
  }
}
/** Journal scans all ERC20 transfer movements at the Base account and all WETH movements at the RH Treasury. */
export class CustodyLedgerService {
  private readonly confirmations: bigint; private readonly maxBlocks: number; private readonly chain: 8453 | 4663;
  constructor(private readonly store: CustodyLedgerStore, private readonly client: Client, private readonly options: CustodyOptions) {
    this.confirmations = options.confirmations ?? 64n; this.maxBlocks = options.maxBlocks ?? 1000; this.chain = options.id === "base_automation" ? 8453 : 4663;
    if (this.confirmations < 1n || !Number.isSafeInteger(this.maxBlocks) || this.maxBlocks < 1 || this.maxBlocks > 1000) throw new Error("Invalid custody scan bound");
  }
  private async head() { if (await this.client.getChainId() !== this.chain) throw new Error("Custody RPC chain mismatch"); const head = await this.client.getBlockNumber(); return head > this.confirmations ? head - this.confirmations : 0n; }
  private async block(number: bigint): Promise<VaultLedgerBlock> {
    const block = await this.client.getBlock({blockNumber:number}); if (!block.hash || block.number !== number) throw new Error("Custody block unavailable");
    return {number:String(number),hash:block.hash,parentHash:block.parentHash};
  }
  private assertGraph(state: CustodyState) { if (state.id !== this.options.id || state.chainId !== this.chain || !eq(state.account,this.options.account)) throw new Error("Custody graph mismatch"); }
  private async balances(assets: string[], number: bigint) {
    const result: Record<string,string> = {};
    for (let index=0;index<assets.length;index+=20) {
      const group=assets.slice(index,index+20),values=await Promise.all(group.map(asset=>this.client.readContract({address:asset as Address,abi:erc20Abi,functionName:"balanceOf",args:[this.options.account],blockNumber:number})));
      group.forEach((asset,index)=>{result[asset.toLowerCase()]=String(values[index]);});
    }
    return result;
  }
  async establishCheckpoint(guard: () => Promise<boolean>): Promise<CustodyReport> {
    if (await this.store.custodyLedgerState(this.options.id)) return this.read();
    if (!await guard()) throw new Error("Custody checkpoint requires a verified pre-Base-funding guard");
    const head = await this.head(), block = await this.block(head), balances = await this.balances(this.options.initialAssets,head);
    if (!eq((await this.block(head)).hash,block.hash) || !await guard()) throw new Error("Custody checkpoint changed during initialization");
    const state: CustodyState = {version:1,id:this.options.id,chainId:this.chain,account:this.options.account,revision:1,checkpoint:block,cursor:block,
      openingBalances:balances,observedBalances:balances,updatedAt:Date.now(),blockedReason:null};
    await this.store.commitCustodyLedger({expectedRevision:0,state,blocks:[block],events:[]}); return this.read();
  }
  async read(): Promise<CustodyReport> {
    const head = await this.head(), state = await this.store.custodyLedgerState(this.options.id);
    if (!state) return emptyCustodyReport(this.options.id,head); this.assertGraph(state);
    if (BigInt(state.cursor.number) > head || !eq((await this.block(BigInt(state.cursor.number))).hash,state.cursor.hash) ||
      !eq((await this.block(BigInt(state.checkpoint.number))).hash,state.checkpoint.hash)) return emptyCustodyReport(this.options.id,head,"Custody journal reorg; reconciliation required");
    const events = await readAllCustodyEvents(this.store,this.options.id);
    for (const event of events) if (event.evidence && (!event.fragments || !this.options.verifyEvidence || !await this.options.verifyEvidence(event,event.evidence,event.fragments)))
      return emptyCustodyReport(this.options.id,head,"Canonical source provenance unavailable; attribution withheld");
    if ((await this.store.custodyLedgerState(this.options.id))?.revision !== state.revision || !eq((await this.block(BigInt(state.cursor.number))).hash,state.cursor.hash))
      return emptyCustodyReport(this.options.id,head,"Custody journal changed during read; retry");
    return replayCustodyLedger(state,events,head);
  }
  async reconcile(maxDurationMs = 45_000): Promise<CustodyReport> {
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0 || maxDurationMs > 60_000) throw new Error("Invalid custody maintenance budget");
    const deadline = Date.now()+maxDurationMs, head = await this.head(); let state = await this.store.custodyLedgerState(this.options.id);
    if (!state) return emptyCustodyReport(this.options.id,head); this.assertGraph(state);
    if (BigInt(state.cursor.number) > head || !eq((await this.block(BigInt(state.cursor.number))).hash,state.cursor.hash)) {
      let ancestor: VaultLedgerBlock | undefined, before: string | undefined;
      for (;;) {
        const page = await this.store.custodyLedgerBlockPage(this.options.id,100,before);
        for (const candidate of page) if (BigInt(candidate.number) <= head && eq((await this.block(BigInt(candidate.number))).hash,candidate.hash)) {ancestor=candidate;break;}
        if (ancestor || page.length < 100) break; before=page.at(-1)!.number;
      }
      if (!ancestor || BigInt(ancestor.number) < BigInt(state.checkpoint.number)) {
        await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,updatedAt:Date.now(),blockedReason:"Custody checkpoint reorg; audited recovery required"},blocks:[],events:[]}); return this.read();
      }
      state = await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,cursor:ancestor,revision:state.revision+1,observedBalances:await this.balances(Object.keys(state.openingBalances),BigInt(ancestor.number)),updatedAt:Date.now(),blockedReason:null},blocks:[],events:[],rollbackAfterBlock:ancestor.number});
    }
    let scanned=0;
    while (BigInt(state.cursor.number) < head && scanned < this.maxBlocks && !state.blockedReason && Date.now() < deadline) {
      const from=BigInt(state.cursor.number)+1n,count=Math.min(100,this.maxBlocks-scanned),to=from+BigInt(count-1)<head?from+BigInt(count-1):head,before=await this.block(to);
      const filter=this.options.id === "robinhood_treasury" ? {address:this.options.initialAssets[0]} : {};
      // At most twenty log calls per atomic page; each provider range remains ten blocks.
      const groups=await Promise.all(Array.from({length:Number((to-from)/10n)+1},(_,index)=>{
        const lower=from+BigInt(index)*10n,upper=lower+9n<to?lower+9n:to;
        return Promise.all([this.client.getLogs({...filter,event:transfer,args:{to:this.options.account},fromBlock:lower,toBlock:upper,strict:true}),
          this.client.getLogs({...filter,event:transfer,args:{from:this.options.account},fromBlock:lower,toBlock:upper,strict:true})]);
      }));
      const incoming=groups.flatMap(group=>group[0]),outgoing=groups.flatMap(group=>group[1]);
      const blocks: VaultLedgerBlock[]=[]; let parent=state.cursor.hash;
      for (let start=from;start<=to;start+=20n) {
        const end=start+19n<to?start+19n:to,group=await Promise.all(Array.from({length:Number(end-start+1n)},(_,index)=>this.block(start+BigInt(index))));
        for (const block of group) { if (!eq(block.parentHash,parent)) throw new Error("Custody ancestry changed");blocks.push(block);parent=block.hash; }
      }
      const blockHashes=new Map(blocks.map(block=>[block.number,block.hash.toLowerCase()]));
      const receipts=new Map<Hex,Awaited<ReturnType<Client["getTransactionReceipt"]>>>(), events: CustodyEvent[]=[];
      for (const log of [...incoming,...outgoing]) {
        if (log.removed || !log.transactionHash || !log.blockHash || log.blockNumber===null || log.logIndex===null || log.transactionIndex===null || blockHashes.get(String(log.blockNumber))!==log.blockHash.toLowerCase()) throw new Error("Noncanonical custody log");
        let receipt=receipts.get(log.transactionHash);if (!receipt) {receipt=await this.client.getTransactionReceipt({hash:log.transactionHash});receipts.set(log.transactionHash,receipt);}
        if (receipt.status!=="success" || !eq(receipt.blockHash,log.blockHash) || receipt.transactionIndex!==log.transactionIndex ||
          !receipt.logs.some(row=>row.logIndex===log.logIndex && eq(row.address,log.address) && row.data===log.data && JSON.stringify(row.topics)===JSON.stringify(log.topics))) throw new Error("Custody log lacks canonical successful receipt");
        const decoded=decodeEventLog({abi:[transfer],data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});
        if (eq(decoded.args.from,decoded.args.to)) throw new Error("Custody self-transfer is ambiguous");
        const event:CustodyEvent={id:vaultEventId(log.transactionHash,log.logIndex),blockNumber:String(log.blockNumber),blockHash:log.blockHash,transactionHash:log.transactionHash,
          transactionIndex:log.transactionIndex,logIndex:log.logIndex,asset:log.address,kind:eq(decoded.args.to,this.options.account)?"in":"out",from:decoded.args.from,to:decoded.args.to,amount:String(decoded.args.value)};
        if(this.options.id==="robinhood_treasury"&&event.kind==="in"){
          const movements=receipt.logs.flatMap(row=>{if(!eq(row.address,event.from))return[];try{const movement=decodeEventLog({abi:[nativeMovement],data:row.data,topics:row.topics,strict:true});return eq(movement.args.from,event.from)&&eq(movement.args.to,event.to)&&eq(movement.args.currency,event.asset)&&String(movement.args.amount)===event.amount?[movement.args.metadata]:[];}catch{return[];}});
          if(movements.length===1)event.nativeRequestMetadata=movements[0];
        }
        events.push(event);
      }
      const opening={...state.openingBalances};
      for (const event of events) if (!(event.asset.toLowerCase() in opening)) Object.assign(opening,await this.balances([event.asset],BigInt(state.checkpoint.number)));
      const observed=await this.balances(Object.keys(opening),to);
      if (!eq((await this.block(to)).hash,before.hash) || !eq(blocks.at(-1)!.hash,before.hash)) throw new Error("Custody range changed");
      state=await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,cursor:before,openingBalances:opening,observedBalances:observed,revision:state.revision+1,updatedAt:Date.now()},blocks,events});scanned+=Number(to-from+1n);
    }
    return this.read();
  }
  async classify(eventId: string, fragments: CustodyFragment[], evidence: CustodyEvidence): Promise<CustodyReport> {
    const state=await this.store.custodyLedgerState(this.options.id);if(!state)throw new Error("Custody checkpoint missing");this.assertGraph(state);
    const event=(await readAllCustodyEvents(this.store,this.options.id)).find(row=>row.id===eventId);
    if (!event || event.kind!=="in" || !this.options.verifyEvidence || !await this.options.verifyEvidence(event,evidence,fragments)) throw new Error("Custody source provenance is not canonically verified");
    if (!eq((await this.block(BigInt(event.blockNumber))).hash,event.blockHash)) throw new Error("Custody classification reorg");
    const revalidate=!!event.evidence&&!!event.fragments&&!await this.options.verifyEvidence(event,event.evidence,event.fragments);
    await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,updatedAt:Date.now()},blocks:[],events:[],classifications:[{eventId,fragments,evidence,revalidate}]});return this.read();
  }
}
