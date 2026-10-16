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
const RETENTION_SECONDS=400*86400;
const empty=():ApplyResult=>({trades:[],reorg:false,removedPools:[]});
function stale(d:Delivery,block:Block|undefined,floor:number){return d.timestamp<Math.floor(Date.now()/1000)-RETENTION_SECONDS||d.blockNumber<=floor||!!block&&(!!block.verified&&block.hash!==d.blockHash||block.generation>(d.generation??0)||block.generation===(d.generation??0)&&BigInt(block.sequence)>=BigInt(d.sequence));}
export function order(a:OnchainTrade,b:OnchainTrade){return a.blockNumber-b.blockNumber||a.logIndex-b.logIndex;}
export class MemorySwapStore implements SwapStore{
 private trades=new Map<string,OnchainTrade>();private blocks=new Map<number,Block>();private state=new Map<string,unknown>();
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
  const reorg=!!block&&block.hash!==d.blockHash,removedPools:string[]=[];
  const removed=reorg?[...this.trades.values()].filter(t=>t.blockNumber===d.blockNumber):[];
  const trades=d.trades.filter(t=>!this.trades.has(t.id)||reorg&&this.trades.get(t.id)?.blockNumber===d.blockNumber);
  if(this.trades.size-removed.length+trades.length>this.limit+2000||!block&&this.blocks.size>=this.limit+2000)throw new SwapCapacityError();
  if(reorg)for(const t of removed){removedPools.push(t.pool);this.trades.delete(t.id);}
 for(const t of trades){this.trades.set(t.id,t);if(!this.coverage(t.pool))this.set(`coverage:${t.pool}`,t.at);}
  this.blocks.set(d.blockNumber,{block:d.blockNumber,hash:d.blockHash,sequence:d.sequence,generation:d.generation??0,at:d.timestamp,verified:block?.verified??0});
  return {trades,reorg,removedPools:[...new Set(removedPools)]};
 }
 prune(now=Date.now(),batch=500){
  const all=[...this.trades.values()].sort(order),cutoff=Math.floor(now/1000)-RETENTION_SECONDS;
  for(const t of all.filter((t,i)=>i<all.length-this.limit||Date.parse(t.at)/1000<cutoff).slice(0,batch)){this.trades.delete(t.id);this.set(`coverage:${t.pool}`,new Date(Math.max(Date.parse(this.coverage(t.pool)??t.at),Date.parse(t.at)+1000,cutoff*1000)).toISOString());}
  const blocks=[...this.blocks.values()].sort((a,b)=>a.block-b.block);
  for(const b of blocks.filter((b,i)=>b.at<cutoff||i<blocks.length-this.limit).slice(0,batch)){this.blocks.delete(b.block);this.set('floor',Math.max(this.get<number>('floor')??-1,b.block));}
 }
 pendingBlocks(before:number,limit:number){return [...this.blocks.values()].filter(b=>!b.verified&&b.at<=before&&[...this.trades.values()].some(t=>t.blockNumber===b.block)).sort((a,b)=>a.block-b.block).slice(0,limit);}
 verifyBlock(n:number,expected:string,canonical:string){const b=this.blocks.get(n);if(!b||b.verified||b.hash!==expected)return [];const removed:string[]=[];if(expected!==canonical)for(const [id,t]of this.trades)if(t.blockNumber===n){removed.push(t.pool);this.trades.delete(id);}b.hash=canonical;b.verified=1;return [...new Set(removed)];}
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
  const block=[...this.sql.exec("SELECT * FROM swap_blocks WHERE block=?",d.blockNumber)][0] as Block|undefined;if(stale(d,block,this.get<number>('floor')??-1))return empty();
  const reorg=!!block&&block.hash!==d.blockHash,removedPools=reorg?[...this.sql.exec("SELECT DISTINCT pool FROM swap_trades WHERE block=?",d.blockNumber)].map(r=>r.pool as string):[];
  const removed=reorg?[...this.sql.exec('SELECT id FROM swap_trades WHERE block=?',d.blockNumber)].length:0;
  const trades=d.trades.filter(t=>{const existing=[...this.sql.exec('SELECT block FROM swap_trades WHERE id=?',t.id)][0];return !existing||reorg&&existing.block===d.blockNumber;});
  if((this.get<number>('trade-count')??0)-removed+trades.length>this.limit+2000||!block&&(this.get<number>('block-count')??0)>=this.limit+2000)throw new SwapCapacityError();
  if(reorg)this.sql.exec("DELETE FROM swap_trades WHERE block=?",d.blockNumber);
  for(const t of trades){
   this.sql.exec("INSERT INTO swap_trades (id,pool,block,hash,at,payload,log_index) VALUES (?,?,?,?,?,?,?)",t.id,t.pool,t.blockNumber,t.blockHash,Date.parse(t.at)/1000,JSON.stringify(t),t.logIndex);if(!this.coverage(t.pool))this.set(`coverage:${t.pool}`,t.at);}
  this.sql.exec("INSERT OR REPLACE INTO swap_blocks (block,hash,sequence,at,generation,verified) VALUES (?,?,?,?,?,?)",d.blockNumber,d.blockHash,d.sequence,d.timestamp,d.generation??0,block?.verified??0);
  this.set('trade-count',(this.get<number>('trade-count')??0)+trades.length-removed);if(!block)this.set('block-count',(this.get<number>('block-count')??0)+1);
  return {trades,reorg,removedPools};});}
 prune(now=Date.now(),batch=500){this.transaction(()=>{
  const cutoff=Math.floor(now/1000)-RETENTION_SECONDS;
  const count=this.get<number>('trade-count')??0;
  const removed=[...this.sql.exec('SELECT id,pool,at FROM swap_trades WHERE at<? ORDER BY at LIMIT ?',cutoff,batch)];
  const overflow=Math.min(batch,Math.max(0,count-this.limit));if(overflow)for(const r of this.sql.exec('SELECT id,pool,at FROM swap_trades ORDER BY block,log_index LIMIT ?',overflow))if(!removed.some(x=>x.id===r.id)&&removed.length<batch)removed.push(r);
  for(const r of removed){this.sql.exec('DELETE FROM swap_trades WHERE id=?',r.id);this.set(`coverage:${r.pool}`,new Date(Math.max(Date.parse(this.coverage(r.pool)??new Date(r.at*1000).toISOString()),(r.at+1)*1000,cutoff*1000)).toISOString());}
  this.set('trade-count',count-removed.length);
  const blocks=[...this.sql.exec('SELECT block FROM swap_blocks WHERE at<? ORDER BY at LIMIT ?',cutoff,batch)];
  const blockCount=this.get<number>('block-count')??0;
  if(blockCount>this.limit)for(const r of this.sql.exec('SELECT block FROM swap_blocks ORDER BY block LIMIT ?',Math.min(batch,blockCount-this.limit)))if(!blocks.some(x=>x.block===r.block)&&blocks.length<batch)blocks.push(r);
  this.set('block-count',blockCount-blocks.length);
  for(const r of blocks){this.sql.exec('DELETE FROM swap_blocks WHERE block=?',r.block);this.set('floor',Math.max(this.get<number>('floor')??-1,r.block));}
 });}
 pendingBlocks(before:number,limit:number){return [...this.sql.exec('SELECT block,hash FROM swap_blocks WHERE verified=0 AND at<=? AND EXISTS (SELECT 1 FROM swap_trades WHERE swap_trades.block=swap_blocks.block) ORDER BY at,block LIMIT ?',before,limit)] as {block:number;hash:string}[];}
 verifyBlock(n:number,expected:string,canonical:string):string[]{return this.transaction(()=>{const b=[...this.sql.exec('SELECT hash,verified FROM swap_blocks WHERE block=?',n)][0];if(!b||b.verified||b.hash!==expected)return [];const pools=expected!==canonical?[...this.sql.exec('SELECT DISTINCT pool FROM swap_trades WHERE block=?',n)].map(r=>r.pool as string):[];if(expected!==canonical){const removed=[...this.sql.exec('SELECT id FROM swap_trades WHERE block=?',n)].length;this.sql.exec('DELETE FROM swap_trades WHERE block=?',n);this.set('trade-count',(this.get<number>('trade-count')??0)-removed);}this.sql.exec('UPDATE swap_blocks SET hash=?,verified=1 WHERE block=?',canonical,n);return pools;});}
}
