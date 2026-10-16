import type { Delivery } from "./swap-stream";
import type { OnchainTrade } from "../src/lib/swap-stream";
import type { SwapCandleBucket } from "../src/lib/swap-market";
export type ApplyResult={trades:OnchainTrade[];reorg:boolean;removedPools:string[]};
type Block={block:number;hash:string;sequence:string;generation:number;at:number;verified:number};
export interface SwapStore {
 rows(pool:string,limit?:number):OnchainTrade[];window(pool:string,from:number,to:number):Iterable<OnchainTrade>;
 buckets(pool:string,from:number,to:number,seconds:number):SwapCandleBucket[];
 apply(delivery:Delivery):ApplyResult;prune(now?:number,batch?:number):void;
 pendingBlocks(before:number,limit:number):{block:number;hash:string}[];verifyBlock(block:number,expected:string,canonical:string):string[];
 get<T>(key:string):T|undefined;set(key:string,value:unknown):void;coverage(pool:string):string|undefined;
}
export class SwapCapacityError extends Error{constructor(){super("Swap storage capacity is temporarily limited");}}
/** Stored cursor state outside the current format; the delivery is rejected as retryable before any write. */
export class SwapStateError extends Error{override name='SwapStateError';constructor(){super("Swap cursor state is invalid");}}
const RETENTION_SECONDS=400*86400;
const empty=():ApplyResult=>({trades:[],reorg:false,removedPools:[]});
type Cursor={generation:number;sequence:string;hash:string};
/** The only cursor format: per kind, its webhook generation, sequence and delivered block hash, in the existing sequence column. Production
 * stored no swaps before it, so any other value is corrupt state and is never guessed from the block record. */
function cursors(b:Block|undefined):Partial<Record<Delivery['kind'],Cursor>>{
 if(!b)return {};let value:any;try{value=JSON.parse(b.sequence);}catch{throw new SwapStateError();}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries<any>(value).some(([kind,c])=>kind!=='v3'&&kind!=='v4'||!Number.isSafeInteger(c?.generation)||!/^\d{1,40}$/.test(c?.sequence)||!/^0x[\da-f]{64}$/.test(c?.hash)))throw new SwapStateError();
 return value;
}
// Kinds never compare sequences, and a kind replaces only its own rows at a height.
const cursor=(d:Delivery,b:Block)=>cursors(b)[d.kind];
const newer=(d:Delivery,c:Cursor)=>(d.generation??0)>c.generation||(d.generation??0)===c.generation&&BigInt(d.sequence)>BigInt(c.sequence);
const sequence=(d:Delivery,b:Block|undefined)=>JSON.stringify({...cursors(b),[d.kind]:{generation:d.generation??0,sequence:d.sequence,hash:d.blockHash}});
/** Swap logs of a V4 pool carry its 32-byte pool id; V3 rows carry the 20-byte pool address. */
const kindOf=(t:{pool:string}):Delivery['kind']=>t.pool.length===66?'v4':'v3';
const KIND_SQL="CASE WHEN length(pool)=66 THEN 'v4' ELSE 'v3' END";
/** A kind without a cursor at this height has no rows there yet and never displaces another kind. An exact retry (same generation,
 * sequence and hash) is not stale: it idempotently restores missing rows, also after finality. */
function stale(d:Delivery,block:Block|undefined,floor:number){
 if(d.timestamp<Math.floor(Date.now()/1000)-RETENTION_SECONDS||d.blockNumber<=floor)return true;if(!block)return false;if(block.verified&&block.hash!==d.blockHash)return true;
 const c=cursor(d,block);return !!c&&!newer(d,c)&&!(c.generation===(d.generation??0)&&c.sequence===d.sequence&&c.hash===d.blockHash);
}
type Placement='insert'|'skip'|'move'|'alternate';
/** A log id displayed in another block is a reinclusion, not a duplicate. A verified occurrence wins; otherwise a verified or newer
 * delivery is displayed and the other occurrence is kept as an alternate until its block's verification or replacement resolves it. */
function place(d:Delivery,own:Block|undefined,reorg:boolean,at:number|undefined,other:(block:number)=>Block|undefined):Placement{
 if(at===undefined)return 'insert';if(at===d.blockNumber)return reorg?'insert':'skip';
 const b=other(at),c=b&&cursor(d,b);return b?.verified?'skip':own?.verified||!c||newer(d,c)?'move':'alternate';
}
export function order(a:OnchainTrade,b:OnchainTrade){return a.blockNumber-b.blockNumber||a.logIndex-b.logIndex;}
export class MemorySwapStore implements SwapStore{
 private trades=new Map<string,OnchainTrade>();private alternates=new Map<string,OnchainTrade>();private blocks=new Map<number,Block>();private state=new Map<string,unknown>();
 constructor(private limit=50_000){}
 get<T>(key:string){return this.state.get(key) as T|undefined;}set(key:string,value:unknown){this.state.set(key,structuredClone(value));}
 coverage(pool:string){return this.get<string>(`coverage:${pool}`);}
 rows(pool:string,limit=50_000){return [...this.trades.values()].filter(t=>t.pool===pool).sort(order).slice(-limit);}
 *window(pool:string,from:number,to:number){for(const t of this.rows(pool))if(Date.parse(t.at)/1000>=from&&Date.parse(t.at)/1000<to)yield t;}
 buckets(pool:string,from:number,to:number,seconds:number){
  const buckets=new Map<number,SwapCandleBucket>();for(const t of this.window(pool,from,to)){const time=Math.floor(Date.parse(t.at)/1000/seconds)*seconds,price=Number(t.priceQuote),volume=Number(t.quoteAmount);if(!(price>0)||!Number.isFinite(price)||!Number.isFinite(volume))continue;
   const b=buckets.get(time);if(b){b.bar.high=Math.max(b.bar.high,price);b.bar.low=Math.min(b.bar.low,price);b.bar.volume+=volume;b.bar.close=price;b.last=t;}else buckets.set(time,{bar:{time,open:price,high:price,low:price,close:price,volume},last:t});
  }return [...buckets.values()].sort((a,b)=>a.bar.time-b.bar.time).slice(-200);
 }
 apply(d:Delivery):ApplyResult{
  const block=this.blocks.get(d.blockNumber);if(stale(d,block,this.get<number>('floor')??-1))return empty();
  const c=block&&cursor(d,block),reorg=!!c&&c.hash!==d.blockHash,removed=reorg?[...this.trades.values()].filter(t=>t.blockNumber===d.blockNumber&&kindOf(t)===d.kind):[];
  const plan=d.trades.map(t=>({t,action:place(d,block,reorg,this.trades.get(t.id)?.blockNumber,n=>this.blocks.get(n))}));
  // Removed ids that this delivery does not re-insert come back from a surviving alternate; the ceiling counts them before any write.
  const incoming=new Set(d.trades.map(t=>t.id)),surviving=new Set([...this.alternates.values()].filter(a=>a.blockNumber!==d.blockNumber).map(a=>a.id)),restorable=removed.filter(t=>!incoming.has(t.id)&&surviving.has(t.id)).length;
  if(this.trades.size-removed.length+plan.filter(p=>p.action==='insert').length+restorable>this.limit+2000||!block&&this.blocks.size>=this.limit+2000)throw new SwapCapacityError();
  if(reorg)this.drop(d.blockNumber,d.kind);
  const trades:OnchainTrade[]=[],moved:string[]=[];
  for(const {t,action} of plan){if(action==='skip')continue;if(action==='alternate'){this.alternates.set(`${t.id}@${t.blockNumber}`,t);continue;}
   if(action==='move'){const old=this.trades.get(t.id)!;this.alternates.set(`${t.id}@${old.blockNumber}`,old);moved.push(old.pool);}this.put(t);trades.push(t);}
  const restored=this.promote(removed.map(t=>t.id));
  this.blocks.set(d.blockNumber,{block:d.blockNumber,hash:d.blockHash,sequence:sequence(d,block),generation:d.generation??0,at:d.timestamp,verified:block?.verified??0});
  return {trades,reorg:reorg||moved.length>0,removedPools:[...new Set([...removed.map(t=>t.pool),...moved,...restored])]};
 }
 private put(t:OnchainTrade){this.alternates.delete(`${t.id}@${t.blockNumber}`);this.trades.set(t.id,t);if(!this.coverage(t.pool))this.set(`coverage:${t.pool}`,t.at);}
 /** Removes one kind's displayed rows and alternates at a height. */
 private drop(n:number,kind:Delivery['kind']){for(const [id,t] of this.trades)if(t.blockNumber===n&&kindOf(t)===kind)this.trades.delete(id);for(const [k,t] of this.alternates)if(t.blockNumber===n&&kindOf(t)===kind)this.alternates.delete(k);}
 /** Restores each removed id from its best surviving occurrence: verified first, then the highest block. */
 private promote(ids:string[]){const pools:string[]=[];for(const id of ids){if(this.trades.has(id))continue;
  const best=[...this.alternates.values()].filter(t=>t.id===id).sort((a,b)=>(this.blocks.get(b.blockNumber)?.verified??0)-(this.blocks.get(a.blockNumber)?.verified??0)||b.blockNumber-a.blockNumber)[0];
  if(best){this.put(best);pools.push(best.pool);}}return pools;}
 prune(now=Date.now(),batch=500){
  const all=[...this.trades.values()].sort(order),cutoff=Math.floor(now/1000)-RETENTION_SECONDS;
  for(const t of all.filter((t,i)=>i<all.length-this.limit||Date.parse(t.at)/1000<cutoff).slice(0,batch)){this.trades.delete(t.id);for(const [k,a] of this.alternates)if(a.id===t.id)this.alternates.delete(k);this.set(`coverage:${t.pool}`,new Date(Math.max(Date.parse(this.coverage(t.pool)??t.at),Date.parse(t.at)+1000,cutoff*1000)).toISOString());}
  const blocks=[...this.blocks.values()].sort((a,b)=>a.block-b.block);
  for(const b of blocks.filter((b,i)=>b.at<cutoff||i<blocks.length-this.limit).slice(0,batch)){this.blocks.delete(b.block);for(const [k,a] of this.alternates)if(a.blockNumber===b.block)this.alternates.delete(k);this.set('floor',Math.max(this.get<number>('floor')??-1,b.block));}
 }
 pendingBlocks(before:number,limit:number){const held=(n:number)=>[...this.trades.values(),...this.alternates.values()].some(t=>t.blockNumber===n);return [...this.blocks.values()].filter(b=>!b.verified&&b.at<=before&&held(b.block)).sort((a,b)=>a.block-b.block).slice(0,limit);}
 /** Every row and alternate at the height whose own block hash is not canonical is an orphan, whatever its kind; each removed id is
  * restored from a surviving occurrence, and canonical alternates become the displayed occurrences. */
 verifyBlock(n:number,expected:string,canonical:string){const b=this.blocks.get(n);if(!b||b.verified||b.hash!==expected)return [];
  const removed=[...this.trades.values()].filter(t=>t.blockNumber===n&&t.blockHash!==canonical),pools=removed.map(t=>t.pool);
  for(const t of removed)this.trades.delete(t.id);for(const [k,t] of this.alternates)if(t.blockNumber===n&&t.blockHash!==canonical)this.alternates.delete(k);
  pools.push(...this.promote(removed.map(t=>t.id)));for(const t of [...this.alternates.values()].filter(t=>t.blockNumber===n)){pools.push(t.pool);this.put(t);}
  b.hash=canonical;b.verified=1;return [...new Set(pools)];}
}
/** Structural types keep this adapter testable with Node's native SQLite. */
type Sql={exec(query:string,...args:any[]):Iterable<Record<string,any>>};
export class SqlSwapStore implements SwapStore{
 constructor(private sql:Sql,private transaction:<T>(fn:()=>T)=>T,private limit=50_000){
  sql.exec("CREATE TABLE IF NOT EXISTS swap_trades (id TEXT PRIMARY KEY,pool TEXT NOT NULL,block INTEGER NOT NULL,hash TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,log_index INTEGER NOT NULL DEFAULT 0)");
  if(![...sql.exec('PRAGMA table_info(swap_trades)')].some(r=>r.name==='log_index')){sql.exec('ALTER TABLE swap_trades ADD COLUMN log_index INTEGER NOT NULL DEFAULT 0');sql.exec("UPDATE swap_trades SET log_index=json_extract(payload,'$.logIndex')");}
  sql.exec("DROP INDEX IF EXISTS swap_pool");
  sql.exec("CREATE INDEX IF NOT EXISTS swap_pool_order ON swap_trades(pool,block,log_index)");
  sql.exec("CREATE INDEX IF NOT EXISTS swap_pool_time ON swap_trades(pool,at,block,log_index)");
  sql.exec("CREATE INDEX IF NOT EXISTS swap_time ON swap_trades(at)");sql.exec("CREATE INDEX IF NOT EXISTS swap_block ON swap_trades(block,log_index)");
  sql.exec("CREATE TABLE IF NOT EXISTS swap_blocks (block INTEGER PRIMARY KEY,hash TEXT NOT NULL,sequence TEXT NOT NULL,at INTEGER NOT NULL,generation INTEGER NOT NULL,verified INTEGER NOT NULL DEFAULT 0)");
  if(![...sql.exec('PRAGMA table_info(swap_blocks)')].some(r=>r.name==='verified'))sql.exec('ALTER TABLE swap_blocks ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
  sql.exec("CREATE INDEX IF NOT EXISTS swap_block_time ON swap_blocks(at)");sql.exec("CREATE INDEX IF NOT EXISTS swap_unverified ON swap_blocks(verified,at,block)");
  // Other occurrences of a displayed log id in unverified blocks; resolved by verification, replacement or pruning of their block.
  sql.exec("CREATE TABLE IF NOT EXISTS swap_alternates (id TEXT NOT NULL,block INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,block))");sql.exec("CREATE INDEX IF NOT EXISTS swap_alternate_block ON swap_alternates(block)");
  sql.exec("CREATE TABLE IF NOT EXISTS swap_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  // One bootstrap count for existing tables; alarm and delivery paths use indexed state lookups.
  if(this.get<number>('trade-count')===undefined)this.set('trade-count',[...sql.exec('SELECT COUNT(*) AS n FROM swap_trades')][0].n);
  if(this.get<number>('block-count')===undefined)this.set('block-count',[...sql.exec('SELECT COUNT(*) AS n FROM swap_blocks')][0].n);
 }
 get<T>(key:string):T|undefined{const row=[...this.sql.exec("SELECT value FROM swap_state WHERE key=?",key)][0];return row?JSON.parse(row.value):undefined;}
 set(key:string,value:unknown){this.sql.exec("INSERT OR REPLACE INTO swap_state VALUES (?,?)",key,JSON.stringify(value));}
 coverage(pool:string){return this.get<string>(`coverage:${pool}`);}
 rows(pool:string,limit=50_000):OnchainTrade[]{return [...this.sql.exec("SELECT payload FROM swap_trades WHERE pool=? ORDER BY block DESC,log_index DESC LIMIT ?",pool,limit)].map(r=>JSON.parse(r.payload)).reverse();}
 *window(pool:string,from:number,to:number):Iterable<OnchainTrade>{for(const r of this.sql.exec("SELECT payload FROM swap_trades WHERE pool=? AND at>=? AND at<? ORDER BY at,block,log_index",pool,from,to))yield JSON.parse(r.payload);}
 buckets(pool:string,from:number,to:number,seconds:number):SwapCandleBucket[]{
  const rows=this.sql.exec(`WITH prices AS (
   SELECT CAST(at/? AS INTEGER)*? AS bucket,block,log_index,payload,CAST(json_extract(payload,'$.priceQuote') AS REAL) AS price,CAST(json_extract(payload,'$.quoteAmount') AS REAL) AS volume
   FROM swap_trades WHERE pool=? AND at>=? AND at<?
  ), ranked AS (
   SELECT *,ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY block,log_index) AS first,ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY block DESC,log_index DESC) AS last
   FROM prices WHERE price>0 AND price<=1.7976931348623157e308 AND volume>=0 AND volume<=1.7976931348623157e308
  ) SELECT bucket AS time,MAX(CASE WHEN first=1 THEN price END) AS open,MAX(price) AS high,MIN(price) AS low,MAX(CASE WHEN last=1 THEN price END) AS close,SUM(volume) AS volume,MAX(CASE WHEN last=1 THEN payload END) AS payload
  FROM ranked GROUP BY bucket ORDER BY bucket DESC LIMIT 200`,seconds,seconds,pool,from,to);
  return [...rows].map(r=>({bar:{time:r.time,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume},last:JSON.parse(r.payload)})).reverse();
 }
 apply(d:Delivery):ApplyResult{return this.transaction(()=>{
  const block=this.block(d.blockNumber);if(stale(d,block,this.get<number>('floor')??-1))return empty();
  const c=block&&cursor(d,block),reorg=!!c&&c.hash!==d.blockHash,removed=reorg?[...this.sql.exec(`SELECT id,pool FROM swap_trades WHERE block=? AND ${KIND_SQL}=?`,d.blockNumber,d.kind)] as {id:string;pool:string}[]:[];
  const plan=d.trades.map(t=>({t,action:place(d,block,reorg,[...this.sql.exec('SELECT block FROM swap_trades WHERE id=?',t.id)][0]?.block as number|undefined,n=>this.block(n))}));
  // Removed ids that this delivery does not re-insert come back from a surviving alternate; the ceiling counts them before any write.
  const incoming=new Set(d.trades.map(t=>t.id)),restorable=reorg?[...this.sql.exec(`SELECT t.id FROM swap_trades t WHERE t.block=? AND ${KIND_SQL}=? AND EXISTS (SELECT 1 FROM swap_alternates a WHERE a.id=t.id AND a.block<>t.block)`,d.blockNumber,d.kind)].filter(r=>!incoming.has(r.id)).length:0;
  if((this.get<number>('trade-count')??0)-removed.length+plan.filter(p=>p.action==='insert').length+restorable>this.limit+2000||!block&&(this.get<number>('block-count')??0)>=this.limit+2000)throw new SwapCapacityError();
  if(reorg)this.drop(d.blockNumber,d.kind,removed.length);
  const trades:OnchainTrade[]=[],moved:string[]=[];
  for(const {t,action} of plan){if(action==='skip')continue;if(action==='alternate'){this.alternate(t.id,t.blockNumber,JSON.stringify(t));continue;}
   if(action==='move'){const old=[...this.sql.exec('SELECT pool,block,payload FROM swap_trades WHERE id=?',t.id)][0];this.alternate(t.id,old.block,old.payload);moved.push(old.pool);}else this.count(1);this.put(t);trades.push(t);}
  const restored=this.promote(removed.map(r=>r.id));
  this.sql.exec("INSERT OR REPLACE INTO swap_blocks (block,hash,sequence,at,generation,verified) VALUES (?,?,?,?,?,?)",d.blockNumber,d.blockHash,sequence(d,block),d.timestamp,d.generation??0,block?.verified??0);
  if(!block)this.set('block-count',(this.get<number>('block-count')??0)+1);
  return {trades,reorg:reorg||moved.length>0,removedPools:[...new Set([...removed.map(r=>r.pool),...moved,...restored])]};});}
 private block(n:number){return [...this.sql.exec("SELECT * FROM swap_blocks WHERE block=?",n)][0] as Block|undefined;}
 private count(delta:number){if(delta)this.set('trade-count',(this.get<number>('trade-count')??0)+delta);}
 private alternate(id:string,block:number,payload:string){this.sql.exec('INSERT OR REPLACE INTO swap_alternates (id,block,payload) VALUES (?,?,?)',id,block,payload);}
 private put(t:OnchainTrade){this.sql.exec('DELETE FROM swap_alternates WHERE id=? AND block=?',t.id,t.blockNumber);
  this.sql.exec("INSERT OR REPLACE INTO swap_trades (id,pool,block,hash,at,payload,log_index) VALUES (?,?,?,?,?,?,?)",t.id,t.pool,t.blockNumber,t.blockHash,Date.parse(t.at)/1000,JSON.stringify(t),t.logIndex);if(!this.coverage(t.pool))this.set(`coverage:${t.pool}`,t.at);}
 /** Removes one kind's displayed rows and alternates at a height. */
 private drop(n:number,kind:Delivery['kind'],removed:number){this.sql.exec(`DELETE FROM swap_trades WHERE block=? AND ${KIND_SQL}=?`,n,kind);this.sql.exec(`DELETE FROM swap_alternates WHERE block=? AND ${KIND_SQL.replace('pool',"json_extract(payload,'$.pool')")}=?`,n,kind);this.count(-removed);}
 private promote(ids:string[]){const pools:string[]=[];for(const id of ids){if([...this.sql.exec('SELECT 1 FROM swap_trades WHERE id=?',id)].length)continue;
  const r=[...this.sql.exec('SELECT a.payload FROM swap_alternates a LEFT JOIN swap_blocks b ON b.block=a.block WHERE a.id=? ORDER BY COALESCE(b.verified,0) DESC,a.block DESC LIMIT 1',id)][0];
  if(r){const t=JSON.parse(r.payload) as OnchainTrade;this.put(t);this.count(1);pools.push(t.pool);}}return pools;}
 prune(now=Date.now(),batch=500){this.transaction(()=>{
  const cutoff=Math.floor(now/1000)-RETENTION_SECONDS;
  const count=this.get<number>('trade-count')??0;
  const removed=[...this.sql.exec('SELECT id,pool,at FROM swap_trades WHERE at<? ORDER BY at LIMIT ?',cutoff,batch)];
  const overflow=Math.min(batch,Math.max(0,count-this.limit));if(overflow)for(const r of this.sql.exec('SELECT id,pool,at FROM swap_trades ORDER BY block,log_index LIMIT ?',overflow))if(!removed.some(x=>x.id===r.id)&&removed.length<batch)removed.push(r);
  for(const r of removed){this.sql.exec('DELETE FROM swap_trades WHERE id=?',r.id);this.sql.exec('DELETE FROM swap_alternates WHERE id=?',r.id);this.set(`coverage:${r.pool}`,new Date(Math.max(Date.parse(this.coverage(r.pool)??new Date(r.at*1000).toISOString()),(r.at+1)*1000,cutoff*1000)).toISOString());}
  this.set('trade-count',count-removed.length);
  const blocks=[...this.sql.exec('SELECT block FROM swap_blocks WHERE at<? ORDER BY at LIMIT ?',cutoff,batch)];
  const blockCount=this.get<number>('block-count')??0;
  if(blockCount>this.limit)for(const r of this.sql.exec('SELECT block FROM swap_blocks ORDER BY block LIMIT ?',Math.min(batch,blockCount-this.limit)))if(!blocks.some(x=>x.block===r.block)&&blocks.length<batch)blocks.push(r);
  this.set('block-count',blockCount-blocks.length);
  for(const r of blocks){this.sql.exec('DELETE FROM swap_blocks WHERE block=?',r.block);this.sql.exec('DELETE FROM swap_alternates WHERE block=?',r.block);this.set('floor',Math.max(this.get<number>('floor')??-1,r.block));}
 });}
 pendingBlocks(before:number,limit:number){return [...this.sql.exec('SELECT block,hash FROM swap_blocks WHERE verified=0 AND at<=? AND (EXISTS (SELECT 1 FROM swap_trades WHERE swap_trades.block=swap_blocks.block) OR EXISTS (SELECT 1 FROM swap_alternates WHERE swap_alternates.block=swap_blocks.block)) ORDER BY at,block LIMIT ?',before,limit)] as {block:number;hash:string}[];}
 verifyBlock(n:number,expected:string,canonical:string):string[]{return this.transaction(()=>{
  const b=[...this.sql.exec('SELECT hash,verified FROM swap_blocks WHERE block=?',n)][0];if(!b||b.verified||b.hash!==expected)return [];
  // Every row and alternate whose own block hash is not canonical is an orphan, whatever its kind.
  const removed=[...this.sql.exec('SELECT id,pool FROM swap_trades WHERE block=? AND hash<>?',n,canonical)] as {id:string;pool:string}[],pools=removed.map(r=>r.pool);
  this.sql.exec('DELETE FROM swap_trades WHERE block=? AND hash<>?',n,canonical);this.sql.exec("DELETE FROM swap_alternates WHERE block=? AND json_extract(payload,'$.blockHash')<>?",n,canonical);this.count(-removed.length);
  pools.push(...this.promote(removed.map(r=>r.id)));
  for(const r of [...this.sql.exec('SELECT payload FROM swap_alternates WHERE block=?',n)]){const t=JSON.parse(r.payload) as OnchainTrade;if(![...this.sql.exec('SELECT 1 FROM swap_trades WHERE id=?',t.id)].length)this.count(1);this.put(t);pools.push(t.pool);}
  this.sql.exec('UPDATE swap_blocks SET hash=?,verified=1 WHERE block=?',canonical,n);return [...new Set(pools)];});}
}
