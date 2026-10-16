import type { Delivery } from "./swap-stream";
import type { OnchainTrade } from "../src/lib/swap-stream";
export type ApplyResult={trades:OnchainTrade[];reorg:boolean;removedPools:string[]};
export interface SwapStore {rows(pool:string):OnchainTrade[];apply(delivery:Delivery):ApplyResult;get<T>(key:string):T|undefined;set(key:string,value:unknown):void;coverage(pool:string):string|undefined;}
const RETENTION_SECONDS=400*86400;
export class MemorySwapStore implements SwapStore{
 private trades=new Map<string,OnchainTrade>();private blocks=new Map<number,{hash:string;sequence:string;generation:number;timestamp:number}>();private state=new Map<string,unknown>();
 constructor(private limit=50_000){}
 get<T>(key:string){return this.state.get(key) as T|undefined;}set(key:string,value:unknown){this.state.set(key,structuredClone(value));}
 coverage(pool:string){return this.get<string>(`coverage:${pool}`);}
 rows(pool:string){return [...this.trades.values()].filter(t=>t.pool===pool).sort(order);}
 apply(d:Delivery){
  const block=this.blocks.get(d.blockNumber);if(d.timestamp<Math.floor(Date.now()/1000)-RETENTION_SECONDS||d.blockNumber<=(this.get<number>("floor")??-1)||block&&(block.generation>(d.generation??0)||block.generation===(d.generation??0)&&BigInt(block.sequence)>=BigInt(d.sequence)))return {trades:[],reorg:false,removedPools:[]};
  const reorg=!!block&&block.hash!==d.blockHash,removedPools:string[]=[];
  if(reorg)for(const [id,t]of this.trades)if(t.blockNumber===d.blockNumber){removedPools.push(t.pool);this.trades.delete(id);}
  const trades=d.trades.filter(t=>!this.trades.has(t.id));for(const t of trades){this.trades.set(t.id,t);if(!this.coverage(t.pool))this.set(`coverage:${t.pool}`,t.at);}
  this.blocks.set(d.blockNumber,{hash:d.blockHash,sequence:d.sequence,generation:d.generation??0,timestamp:d.timestamp});
  const all=[...this.trades.values()].sort(order),cutoff=Math.floor(Date.now()/1000)-RETENTION_SECONDS;
  for(const [i,t]of all.entries())if(i<all.length-this.limit||Date.parse(t.at)/1000<cutoff){this.trades.delete(t.id);this.set(`coverage:${t.pool}`,new Date(Math.max(Date.parse(t.at)+1000,Date.now()-RETENTION_SECONDS*1000)).toISOString());}
  for(const [n,b]of this.blocks)if(b.timestamp<cutoff){this.blocks.delete(n);this.set("floor",Math.max(this.get<number>("floor")??-1,n));}
  for(const n of [...this.blocks.keys()].sort((a,b)=>b-a).slice(this.limit)){this.blocks.delete(n);this.set("floor",Math.max(this.get<number>("floor")??-1,n));}
  return {trades,reorg,removedPools:[...new Set(removedPools)]};
 }
}
export function order(a:OnchainTrade,b:OnchainTrade){return a.blockNumber-b.blockNumber||a.logIndex-b.logIndex;}
/** Structural types keep this adapter testable with Node's native SQLite. */
type Sql={exec(query:string,...args:any[]):Iterable<Record<string,any>>};
export class SqlSwapStore implements SwapStore{
 constructor(private sql:Sql,private transaction:<T>(fn:()=>T)=>T,private limit=50_000){
 sql.exec("CREATE TABLE IF NOT EXISTS swap_trades (id TEXT PRIMARY KEY,pool TEXT NOT NULL,block INTEGER NOT NULL,hash TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL)");
 sql.exec("CREATE INDEX IF NOT EXISTS swap_pool ON swap_trades(pool,block)");
 sql.exec("CREATE TABLE IF NOT EXISTS swap_blocks (block INTEGER PRIMARY KEY,hash TEXT NOT NULL,sequence TEXT NOT NULL,at INTEGER NOT NULL,generation INTEGER NOT NULL)");
 sql.exec("CREATE TABLE IF NOT EXISTS swap_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
 }
 get<T>(key:string):T|undefined{const row=[...this.sql.exec("SELECT value FROM swap_state WHERE key=?",key)][0];return row?JSON.parse(row.value):undefined;}
 set(key:string,value:unknown){this.sql.exec("INSERT OR REPLACE INTO swap_state VALUES (?,?)",key,JSON.stringify(value));}
 coverage(pool:string){return this.get<string>(`coverage:${pool}`);}
 rows(pool:string):OnchainTrade[]{return [...this.sql.exec("SELECT payload FROM swap_trades WHERE pool=? ORDER BY block, id",pool)].map(r=>JSON.parse(r.payload)).sort(order);}
 apply(d:Delivery):ApplyResult{return this.transaction(()=>{
 const block=[...this.sql.exec("SELECT * FROM swap_blocks WHERE block=?",d.blockNumber)][0];if(d.timestamp<Math.floor(Date.now()/1000)-RETENTION_SECONDS||d.blockNumber<=(this.get<number>("floor")??-1)||block&&(block.generation>(d.generation??0)||block.generation===(d.generation??0)&&BigInt(block.sequence)>=BigInt(d.sequence)))return {trades:[],reorg:false,removedPools:[]};
 const reorg=!!block&&block.hash!==d.blockHash,removedPools=reorg?[...this.sql.exec("SELECT DISTINCT pool FROM swap_trades WHERE block=?",d.blockNumber)].map(r=>r.pool as string):[];
 if(reorg)this.sql.exec("DELETE FROM swap_trades WHERE block=?",d.blockNumber);
 const trades:OnchainTrade[]=[];for(const t of d.trades){if([...this.sql.exec("SELECT id FROM swap_trades WHERE id=?",t.id)].length)continue;
 this.sql.exec("INSERT INTO swap_trades VALUES (?,?,?,?,?,?)",t.id,t.pool,t.blockNumber,t.blockHash,Date.parse(t.at)/1000,JSON.stringify(t));trades.push(t);if(!this.coverage(t.pool))this.set(`coverage:${t.pool}`,t.at);}
 this.sql.exec("INSERT OR REPLACE INTO swap_blocks VALUES (?,?,?,?,?)",d.blockNumber,d.blockHash,d.sequence,d.timestamp,d.generation??0);
 const cutoff=Math.floor(Date.now()/1000)-RETENTION_SECONDS;
 const removed=[...this.sql.exec("SELECT pool,MAX(at) AS at FROM swap_trades WHERE at<? OR id IN (SELECT id FROM swap_trades ORDER BY block DESC,id DESC LIMIT -1 OFFSET ?) GROUP BY pool",cutoff,this.limit)];
 for(const r of removed)this.set(`coverage:${r.pool}`,new Date(Math.max((r.at+1)*1000,cutoff*1000)).toISOString());
 this.sql.exec("DELETE FROM swap_trades WHERE at<? OR id IN (SELECT id FROM swap_trades ORDER BY block DESC,id DESC LIMIT -1 OFFSET ?)",cutoff,this.limit);
 const pruned=[...this.sql.exec("SELECT MAX(block) AS block FROM swap_blocks WHERE at<? OR block IN (SELECT block FROM swap_blocks ORDER BY block DESC LIMIT -1 OFFSET ?)",cutoff,this.limit)][0];
 if(pruned?.block!=null)this.set("floor",Math.max(this.get<number>("floor")??-1,pruned.block));
 this.sql.exec("DELETE FROM swap_blocks WHERE at<? OR block IN (SELECT block FROM swap_blocks ORDER BY block DESC LIMIT -1 OFFSET ?)",cutoff,this.limit);
 return {trades,reorg,removedPools};});}
}
