import { AbiDecodingZeroDataError, BaseError, ContractFunctionZeroDataError, decodeEventLog, erc20Abi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { emptyCustodyReport, replayCustodyLedger, type CustodyCommit, type CustodyEvent, type CustodyEvidence, type CustodyFragment,
  type CustodyLedgerId, type CustodyReport, type CustodyState } from "../src/lib/buyback-custody-ledger";
import { vaultEventId, type VaultEventCursor, type VaultLedgerBlock } from "../src/lib/buyback-vault-ledger";
export type CustodyLedgerStore = {
  custodyLedgerState(id: CustodyLedgerId): CustodyState | null | Promise<CustodyState | null>;
  custodyLedgerEventPage(id: CustodyLedgerId, limit?: number, after?: VaultEventCursor): CustodyEvent[] | Promise<CustodyEvent[]>;
  custodyLedgerBlockPage(id: CustodyLedgerId, limit?: number, before?: string): VaultLedgerBlock[] | Promise<VaultLedgerBlock[]>;
  commitCustodyLedger(input: CustodyCommit): CustodyState | Promise<CustodyState>;
};
type Client = Pick<PublicClient, "getChainId" | "getBlockNumber" | "getBlock" | "getLogs" | "getTransactionReceipt" | "readContract" | "getCode">;
const nativeMovement = parseAbiItem("event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)");
const transfer = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export type CustodyOptions = { id: CustodyLedgerId; account: Address; initialAssets: Address[]; confirmations?: bigint; maxBlocks?: number;
  /** Only actual releases at the immutable adapter can introduce a newly launched asset. */
  discoverAssets?: (from: bigint, to: bigint,deadline:number) => Promise<Address[]>;
  /** Canonical verifier, never a browser-provided amount. Called on every attributed read, including after restart/reorg. */
  verifyEvidence?: (event: CustodyEvent, evidence: CustodyEvidence, fragments: CustodyFragment[]) => Promise<boolean> };
export async function readAllCustodyEvents(store: CustodyLedgerStore, id: CustodyLedgerId,deadline=Infinity) {
  const output: CustodyEvent[] = []; let after: VaultEventCursor | undefined;
  for (;;) {
    if(Date.now()>=deadline)throw new Error("Custody maintenance budget reached; pending");
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
  private async balances(assets: string[], number: bigint, opening = false,deadline=Infinity) {
    const values: Record<string,string> = {}, errors: Record<string,string> = {};
    for (let index=0;index<assets.length;index+=20) {
      if(Date.now()>=deadline)throw new Error("Custody maintenance budget reached; pending");
      const group=assets.slice(index,index+20),result=await Promise.allSettled(group.map(async asset=>{
        try { const balance=await this.client.readContract({address:asset as Address,abi:erc20Abi,functionName:"balanceOf",args:[this.options.account],blockNumber:number});
          if(typeof balance!=="bigint"||balance<0n)throw new Error("Invalid token balance");return String(balance);
        } catch(error) {
          const zeroData = (cause: unknown) => cause instanceof AbiDecodingZeroDataError || cause instanceof ContractFunctionZeroDataError;
          // Only a real zero-data ABI result for an actually discovered token
          // may establish absence. Archive, transport, rate-limit and revert errors stay retryable.
          if (opening && !this.options.initialAssets.some(initial => eq(initial,asset)) &&
            (zeroData(error) || error instanceof BaseError && !!error.walk(zeroData))) {
            const current = await this.head();
            if (current > number) {
              const [historicalBlock,currentBlock] = await Promise.all([this.block(number),this.block(current)]);
              const [code,currentCode] = await Promise.all([this.client.getCode({address:asset as Address,blockNumber:number}),this.client.getCode({address:asset as Address,blockNumber:current})]);
              if ((!code || code === "0x") && typeof currentCode === "string" && /^0x(?:[\da-f]{2})+$/i.test(currentCode) &&
                eq((await this.block(number)).hash,historicalBlock.hash) && eq((await this.block(current)).hash,currentBlock.hash)) return "0";
            }
          }
          throw error;
        }
      }));
      result.forEach((result,index)=>{const asset=group[index].toLowerCase();if(result.status==="fulfilled")values[asset]=result.value;else errors[asset]="Canonical token balance unavailable; asset attribution withheld";});
    }
    return {values,errors};
  }
  async establishCheckpoint(guard: () => Promise<boolean>): Promise<CustodyReport> {
    if (await this.store.custodyLedgerState(this.options.id)) return this.read();
    if (!await guard()) throw new Error("Custody checkpoint requires a verified pre-Base-funding guard");
    const head = await this.head(), block = await this.block(head), balances = await this.balances(this.options.initialAssets,head,true);
    if (!eq((await this.block(head)).hash,block.hash) || !await guard()) throw new Error("Custody checkpoint changed during initialization");
    const state: CustodyState = {version:1,id:this.options.id,chainId:this.chain,account:this.options.account,revision:1,checkpoint:block,cursor:block,
      openingBalances:balances.values,observedBalances:balances.values,assetErrors:balances.errors,updatedAt:Date.now(),blockedReason:null};
    await this.store.commitCustodyLedger({expectedRevision:0,state,blocks:[block],events:[]}); return this.read();
  }
  async read(deadline=Infinity): Promise<CustodyReport> {
    if(Date.now()>=deadline)return emptyCustodyReport(this.options.id,0n,"Custody maintenance budget reached; pending");
    const head = await this.head(), state = await this.store.custodyLedgerState(this.options.id);
    if (!state) return emptyCustodyReport(this.options.id,head); this.assertGraph(state);
    if(BigInt(state.cursor.number)>head)return {...emptyCustodyReport(this.options.id,head,"Custody RPC is behind the indexed cursor; pending canonical verification"),revision:state.revision,checkpointBlock:state.checkpoint.number,indexedThrough:state.cursor.number};
    if (!eq((await this.block(BigInt(state.cursor.number))).hash,state.cursor.hash) ||
      !eq((await this.block(BigInt(state.checkpoint.number))).hash,state.checkpoint.hash)) return emptyCustodyReport(this.options.id,head,"Custody journal reorg; reconciliation required");
    const events = await readAllCustodyEvents(this.store,this.options.id,deadline),projected:CustodyEvent[]=[],withheldEventIds:string[]=[];
    for (const event of events) {
      if(Date.now()>=deadline)return emptyCustodyReport(this.options.id,head,"Custody maintenance budget reached; pending");
      let verified=!event.evidence;
      if(event.evidence&&event.fragments&&this.options.verifyEvidence){try{verified=await this.options.verifyEvidence(event,event.evidence,event.fragments);}catch{/* Withhold this lot's provenance, never its real transfer amount. */}}
      // Retain the original evidence in storage so a transient failure can recover.
      // A bad source in shared WETH is an unknown lot, not a WETH balance shortfall.
      projected.push(verified?event:{...event,fragments:undefined,evidence:undefined});if(!verified)withheldEventIds.push(event.id);
    }
    if ((await this.store.custodyLedgerState(this.options.id))?.revision !== state.revision || !eq((await this.block(BigInt(state.cursor.number))).hash,state.cursor.hash))
      return emptyCustodyReport(this.options.id,head,"Custody journal changed during read; retry");
    return {...replayCustodyLedger(state,projected,head),withheldEventIds};
  }
  private async collect(from:bigint,to:bigint,assets:string[],deadline=Infinity,expectedParent?:VaultLedgerBlock) {
      const anchor=expectedParent??await this.block(from-1n);if(anchor.number!==String(from-1n))throw new Error("Custody page anchor mismatch");
      const before=await this.block(to),filter={address:assets as Address[]};
      // At most twenty log calls per atomic page; each provider range remains ten blocks.
      const groups=await Promise.all(Array.from({length:Number((to-from)/10n)+1},(_,index)=>{
        const lower=from+BigInt(index)*10n,upper=lower+9n<to?lower+9n:to;
        return Promise.all([this.client.getLogs({...filter,event:transfer,args:{to:this.options.account},fromBlock:lower,toBlock:upper,strict:true}),
          this.client.getLogs({...filter,event:transfer,args:{from:this.options.account},fromBlock:lower,toBlock:upper,strict:true})]);
      }));
      const incoming=groups.flatMap(group=>group[0]),outgoing=groups.flatMap(group=>group[1]);
      const blocks: VaultLedgerBlock[]=[]; let parent=anchor.hash;
      for (let start=from;start<=to;start+=20n) {
        if(Date.now()>=deadline)throw new Error("Custody maintenance budget reached; pending");
        const end=start+19n<to?start+19n:to,group=await Promise.all(Array.from({length:Number(end-start+1n)},(_,index)=>this.block(start+BigInt(index))));
        for (const block of group) { if (!eq(block.parentHash,parent)) throw new Error("Custody ancestry changed");blocks.push(block);parent=block.hash; }
      }
      const blockHashes=new Map(blocks.map(block=>[block.number,block.hash.toLowerCase()]));
      const receipts=new Map<Hex,Awaited<ReturnType<Client["getTransactionReceipt"]>>>(), events: CustodyEvent[]=[];
      for (const log of [...incoming,...outgoing]) {
        if(Date.now()>=deadline)throw new Error("Custody maintenance budget reached; pending");
        if(!assets.includes(log.address.toLowerCase()))continue;
        if (log.removed || !log.transactionHash || !log.blockHash || log.blockNumber===null || log.logIndex===null || log.transactionIndex===null || blockHashes.get(String(log.blockNumber))!==log.blockHash.toLowerCase()) throw new Error("Noncanonical custody log");
        const decoded=decodeEventLog({abi:[transfer],data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});
        if (decoded.args.value===0n||eq(decoded.args.from,decoded.args.to)) continue;
        let receipt=receipts.get(log.transactionHash);if (!receipt) {receipt=await this.client.getTransactionReceipt({hash:log.transactionHash});receipts.set(log.transactionHash,receipt);}
        if (receipt.status!=="success" || !eq(receipt.blockHash,log.blockHash) || receipt.transactionIndex!==log.transactionIndex ||
          !receipt.logs.some(row=>row.logIndex===log.logIndex && eq(row.address,log.address) && row.data===log.data && JSON.stringify(row.topics)===JSON.stringify(log.topics))) throw new Error("Custody log lacks canonical successful receipt");
        const event:CustodyEvent={id:vaultEventId(log.transactionHash,log.logIndex),blockNumber:String(log.blockNumber),blockHash:log.blockHash,transactionHash:log.transactionHash,
          transactionIndex:log.transactionIndex,logIndex:log.logIndex,asset:log.address,kind:eq(decoded.args.to,this.options.account)?"in":"out",from:decoded.args.from,to:decoded.args.to,amount:String(decoded.args.value)};
        for(const [key,value] of [["nativeTransactionFrom",receipt.from],["nativeTransactionTo",receipt.to]] as const){
          if(value!==undefined&&value!==null){if(!/^0x[\da-f]{40}$/i.test(value))throw new Error("Custody receipt transaction context unavailable");event[key]=value;}
        }
        if(this.options.id==="robinhood_treasury"&&event.kind==="in"){
          const movements=receipt.logs.flatMap(row=>{if(!eq(row.address,event.from))return[];try{const movement=decodeEventLog({abi:[nativeMovement],data:row.data,topics:row.topics,strict:true});return eq(movement.args.from,event.from)&&eq(movement.args.to,event.to)&&eq(movement.args.currency,event.asset)&&String(movement.args.amount)===event.amount?[movement.args.metadata]:[];}catch{return[];}});
          if(movements.length===1)event.nativeRequestMetadata=movements[0];
        }
        events.push(event);
      }
      if(!eq((await this.block(BigInt(anchor.number))).hash,anchor.hash)||!eq((await this.block(to)).hash,before.hash)||!eq(blocks.at(-1)!.hash,before.hash))throw new Error("Custody range changed");
      return {before,blocks,events};
  }
  private newEvents(events:CustodyEvent[],existing:Map<string,CustodyEvent>) {
    return events.filter(event=>{const old=existing.get(event.id);if(!old)return true;const raw=(row:CustodyEvent)=>[row.id,row.blockNumber,row.blockHash,row.transactionHash,row.transactionIndex,row.logIndex,row.asset,row.kind,row.from,row.to,row.amount];
      if(JSON.stringify(raw(old))!==JSON.stringify(raw(event))||old.nativeRequestMetadata!==undefined&&old.nativeRequestMetadata.toLowerCase()!==event.nativeRequestMetadata?.toLowerCase()||old.nativeTransactionFrom!==undefined&&old.nativeTransactionFrom.toLowerCase()!==event.nativeTransactionFrom?.toLowerCase()||old.nativeTransactionTo!==undefined&&old.nativeTransactionTo.toLowerCase()!==event.nativeTransactionTo?.toLowerCase())throw new Error("Conflicting canonical custody event; reconcile first");return false;});
  }
  private async assetStart(asset:Address,checkpoint:bigint,cursor:bigint,deadline:number) {
    try{const old=await this.client.getCode({address:asset,blockNumber:checkpoint});if(old&&old!=="0x")return{start:checkpoint+1n,pending:false};
    const current=await this.client.getCode({address:asset,blockNumber:cursor});if(!current||current==="0x")return{start:checkpoint+1n,pending:true};
    let lower=checkpoint+1n,upper=cursor;
    while(lower<upper){if(Date.now()>=deadline)throw new Error("Custody maintenance budget reached; pending");const middle=(lower+upper)/2n,code=await this.client.getCode({address:asset,blockNumber:middle});if(code&&code!=="0x")upper=middle;else lower=middle+1n;}
    return{start:lower,pending:false};}catch(error){if(Date.now()>=deadline)throw error;return{start:checkpoint+1n,pending:true};}
  }
  async reconcile(maxDurationMs = 45_000): Promise<CustodyReport> {
    if(!Number.isFinite(maxDurationMs)||maxDurationMs<0||maxDurationMs>60_000)throw new Error("Invalid custody maintenance budget");
    const deadline=Date.now()+maxDurationMs,head=await this.head();let state=await this.store.custodyLedgerState(this.options.id);
    const pending=()=>emptyCustodyReport(this.options.id,head,"Custody maintenance budget reached; pending");
    try {
    if(!state)return emptyCustodyReport(this.options.id,head);this.assertGraph(state);
    // A provider behind an already indexed cursor has not proved a reorg. Preserve
    // financial events and wait for that provider to catch up before any mutation.
    if(BigInt(state.cursor.number)>head)return {...emptyCustodyReport(this.options.id,head,"Custody RPC is behind the indexed cursor; pending canonical verification"),revision:state.revision,checkpointBlock:state.checkpoint.number,indexedThrough:state.cursor.number};
    if(!eq((await this.block(BigInt(state.cursor.number))).hash,state.cursor.hash)){
      let ancestor:VaultLedgerBlock|undefined;
      const checkpoint=state.checkpoint;
      if(eq((await this.block(BigInt(checkpoint.number))).hash,checkpoint.hash))ancestor=checkpoint;
      // Recent anchors are contiguous; canonical ancestry has one prefix boundary after a reorg.
      let lower=BigInt(state.cursor.number)-4095n>BigInt(checkpoint.number)+1n?BigInt(state.cursor.number)-4095n:BigInt(checkpoint.number)+1n,upper=BigInt(state.cursor.number)<head?BigInt(state.cursor.number):head;
      while(lower<=upper){if(Date.now()>=deadline)return pending();const middle=(lower+upper)/2n,candidate=(await this.store.custodyLedgerBlockPage(this.options.id,1,String(middle+1n)))[0];
        if(!candidate||BigInt(candidate.number)<lower){lower=middle+1n;continue;}
        if(eq((await this.block(BigInt(candidate.number))).hash,candidate.hash)){ancestor=candidate;lower=middle+1n;}else upper=middle-1n;
      }
      if(Date.now()>=deadline)return pending();
      if(!ancestor){await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,updatedAt:Date.now(),blockedReason:"Custody checkpoint reorg; audited recovery required"},blocks:[],events:[]});return this.read();}
      const observed=await this.balances(Object.keys(state.openingBalances),BigInt(ancestor.number),false,deadline);if(Date.now()>=deadline)return pending();
      const assetCursors=Object.fromEntries(Object.entries(state.assetCursors??{}).map(([asset,cursor])=>[asset,BigInt(cursor.number)>BigInt(ancestor!.number)?ancestor!:cursor]));
      state=await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,cursor:ancestor,assetCursors,revision:state.revision+1,observedBalances:observed.values,assetErrors:observed.errors,updatedAt:Date.now(),blockedReason:null},blocks:[],events:[],rollbackAfterBlock:ancestor.number});
    }
    // Transient token/RPC failures can recover even when no new block is available.
    if(Object.keys(state.assetErrors??{}).length&&Date.now()<deadline){
      const opening={...state.openingBalances},assetCursors={...state.assetCursors},assets=[...new Set([...this.options.initialAssets,...(state.releasedAssets??[])].map(asset=>asset.toLowerCase()))];
      const missing=assets.filter(asset=>!(asset in opening)),added=await this.balances(missing,BigInt(state.checkpoint.number),true,deadline);Object.assign(opening,added.values);
      const originErrors=Object.fromEntries(Object.entries(state.assetErrors??{}).filter(([,reason])=>reason.startsWith("Asset discovery")));
      for(const asset of [...new Set([...missing,...Object.keys(originErrors)])])if(asset in opening){const found=await this.assetStart(asset as Address,BigInt(state.checkpoint.number),BigInt(state.cursor.number),deadline);
        if(found.pending){assetCursors[asset]??=state.checkpoint;originErrors[asset]="Asset discovery code unavailable; original history retained for automatic retry";}
        else{assetCursors[asset]=await this.block(found.start-1n);delete originErrors[asset];}}
      const observed=await this.balances(assets,BigInt(state.cursor.number),false,deadline);if(Date.now()>=deadline)return pending();
      state=await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,openingBalances:opening,assetCursors,observedBalances:observed.values,assetErrors:{...added.errors,...observed.errors,...originErrors},revision:state.revision+1,updatedAt:Date.now()},blocks:[],events:[]});
    }
    // One historical index per turn, updated only by successful commits. A page
    // never performs another full-journal read merely to suppress duplicates.
    let eventIndex:Map<string,CustodyEvent>|undefined;
    const uniqueEvents=async(events:CustodyEvent[])=>{
      if(!events.length)return [];
      eventIndex??=new Map((await readAllCustodyEvents(this.store,this.options.id,deadline)).map(event=>[event.id,event]));
      return this.newEvents(events,eventIndex);
    };
    const committed=(events:CustodyEvent[])=>{if(eventIndex)for(const event of events)eventIndex.set(event.id,event);};
    let scanned=0,backfilled=0;
    // Keep ordinary accounting current first. New asset registration is committed
    // with this canonical page; historical asset work gets its own later commits.
    while(BigInt(state.cursor.number)<head&&scanned<this.maxBlocks&&!state.blockedReason&&Date.now()<deadline){
      const from=BigInt(state.cursor.number)+1n,count=Math.min(100,this.maxBlocks-scanned),to=from+BigInt(count-1)<head?from+BigInt(count-1):head;
      const discovered=await this.options.discoverAssets?.(from,to,deadline)??[],opening={...state.openingBalances},assetCursors={...state.assetCursors};
      const releasedAssets=[...new Set([...(state.releasedAssets??[]),...discovered].map(asset=>asset.toLowerCase()))] as Address[];
      const assets=[...new Set([...this.options.initialAssets,...releasedAssets].map(asset=>asset.toLowerCase()))];
      const missing=assets.filter(asset=>!(asset in opening)),added=await this.balances(missing,BigInt(state.checkpoint.number),true,deadline);Object.assign(opening,added.values);
      const originErrors=Object.fromEntries(Object.entries(state.assetErrors??{}).filter(([,reason])=>reason.startsWith("Asset discovery")));
      for(const asset of missing)if(asset in added.values){const found=await this.assetStart(asset as Address,BigInt(state.checkpoint.number),BigInt(state.cursor.number),deadline);
        if(found.pending){assetCursors[asset]??=state.checkpoint;originErrors[asset]="Asset discovery code unavailable; original history retained for automatic retry";}
        else assetCursors[asset]=await this.block(found.start-1n);}
      const page=await this.collect(from,to,assets,deadline,state.cursor),observed=await this.balances(assets,to,false,deadline),events=await uniqueEvents(page.events);
      for(const asset of Object.keys(assetCursors))if(!originErrors[asset]&&assetCursors[asset].number===state.cursor.number&&eq(assetCursors[asset].hash,state.cursor.hash))assetCursors[asset]=page.before;
      if(!eq((await this.block(BigInt(state.cursor.number))).hash,state.cursor.hash)||!eq((await this.block(BigInt(page.before.number))).hash,page.before.hash))throw new Error("Custody page anchor changed before commit");
      if(Date.now()>=deadline)return pending();
      state=await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,cursor:page.before,openingBalances:opening,releasedAssets,assetCursors,observedBalances:observed.values,assetErrors:{...added.errors,...observed.errors,...originErrors},revision:state.revision+1,updatedAt:Date.now()},blocks:page.blocks,events});
      committed(events);scanned+=Number(to-from+1n);
    }
    // Each asset receives a bounded independent page, with durable fair rotation.
    // An invalid asset anchor or failed token/page cannot discard global progress.
    if(Date.now()<deadline&&!state.blockedReason){
      const queue=Object.entries(state.assetCursors??{}).sort(([left],[right])=>(state!.assetBackfillAt?.[left]??0)-(state!.assetBackfillAt?.[right]??0)||left.localeCompare(right));
      for(const [asset,initialCursor] of queue){
        if(Date.now()>=deadline||backfilled>=this.maxBlocks)break;
        if(state.assetErrors?.[asset]?.startsWith("Asset discovery"))continue;
        let cursor=state.assetCursors![asset]??initialCursor;
        try{
          const anchor=cursor.number===state.cursor.number?state.cursor:await this.block(BigInt(cursor.number));
          if(!eq(anchor.hash,cursor.hash)){
            const found=await this.assetStart(asset as Address,BigInt(state.checkpoint.number),BigInt(state.cursor.number),deadline);
            if(found.pending)throw new Error("Asset deployment evidence unavailable; retained original replay origin");
            cursor=await this.block(found.start-1n);
            if(Date.now()>=deadline)return pending();
            state=await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,assetCursors:{...state.assetCursors,[asset]:cursor},assetErrors:{...state.assetErrors,[asset]:"Asset cursor changed; independent replay pending"},revision:state.revision+1,updatedAt:Date.now()},blocks:[],events:[]});
          }
          if(BigInt(cursor.number)>=BigInt(state.cursor.number))continue;
          const from=BigInt(cursor.number)+1n,to=from+BigInt(Math.min(100,this.maxBlocks-backfilled)-1)<BigInt(state.cursor.number)?from+BigInt(Math.min(100,this.maxBlocks-backfilled)-1):BigInt(state.cursor.number);
          const page=await this.collect(from,to,[asset],deadline,cursor),events=await uniqueEvents(page.events);
          if(!eq((await this.block(BigInt(state.cursor.number))).hash,state.cursor.hash))throw new Error("Custody global anchor changed during asset replay");
          if(Date.now()>=deadline)return pending();
          const assetErrors={...state.assetErrors};if(/^Asset (cursor|backfill)/.test(assetErrors[asset]??""))delete assetErrors[asset];
          state=await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,assetCursors:{...state.assetCursors,[asset]:page.before},assetBackfillAt:{...state.assetBackfillAt,[asset]:Date.now()},assetErrors,revision:state.revision+1,updatedAt:Date.now()},blocks:page.blocks,events});
          committed(events);backfilled+=Number(to-from+1n);
        }catch(error){
          if(Date.now()>=deadline)return pending();
          // The financial cursor remains intact. Only this asset stays withheld,
          // and the next maintenance turn retries its retained canonical anchor.
          state=await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,assetErrors:{...state.assetErrors,[asset]:"Asset backfill canonical page unavailable; isolated replay pending"},assetBackfillAt:{...state.assetBackfillAt,[asset]:Date.now()},revision:state.revision+1,updatedAt:Date.now()},blocks:[],events:[]});
        }
      }
    }
    return Date.now()>=deadline?pending():await this.read(deadline);
    }catch(error){if(Date.now()>=deadline)return pending();throw error;}
  }
  async classify(eventId: string, fragments: CustodyFragment[], evidence: CustodyEvidence, deadline = Infinity): Promise<CustodyReport> {
    const state=await this.store.custodyLedgerState(this.options.id);if(!state)throw new Error("Custody checkpoint missing");this.assertGraph(state);
    const event=(await readAllCustodyEvents(this.store,this.options.id,deadline)).find(row=>row.id===eventId);
    if (!event || event.kind!=="in" || !this.options.verifyEvidence || !await this.options.verifyEvidence(event,evidence,fragments)) throw new Error("Custody source provenance is not canonically verified");
    if (!eq((await this.block(BigInt(event.blockNumber))).hash,event.blockHash)) throw new Error("Custody classification reorg");
    const revalidate=!!event.evidence&&!!event.fragments&&!await this.options.verifyEvidence(event,event.evidence,event.fragments);
    if(Date.now()>=deadline)throw new Error("Custody maintenance budget reached; pending");
    await this.store.commitCustodyLedger({expectedRevision:state.revision,state:{...state,revision:state.revision+1,updatedAt:Date.now()},blocks:[],events:[],classifications:[{eventId,fragments,evidence,revalidate}]});return this.read(deadline);
  }
}
