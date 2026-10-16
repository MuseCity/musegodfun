import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeEventLog, formatUnits, parseAbi, type Hex } from "viem";
import { z } from "zod";
import { assetsFor, contractsFor, deploymentChain, type TokenRecord } from "../src/lib/config";
import { MUSEGOD } from "../src/lib/musegod";
import type { OnchainTrade } from "../src/lib/swap-stream";
export const MUSE_POOL = MUSEGOD.pool.toLowerCase();
export const NETWORKS = {4663:"ROBINHOOD_MAINNET",8453:"BASE_MAINNET"} as const;
export type WebhookKind='v3'|'v4';
export type SwapPool = {chainId:4663|8453;version:3|4;pool:string;token:string;quote:string;tokenDecimals:number;quoteDecimals:number;quoteSymbol:string};
export const V4_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
export const V3_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const abi4=parseAbi(["event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)"]);
const abi3=parseAbi(["event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"]);
const hash=z.string().regex(/^0x[\da-f]{64}$/i), address=z.string().regex(/^0x[\da-f]{40}$/i), integer=z.number().int().safe().nonnegative();
const logSchema=z.object({index:integer,topics:z.array(hash).length(3),data:z.string().regex(/^0x(?:[\da-f]{2})+$/i).max(514),account:z.object({address}),transaction:z.object({hash,from:z.object({address}).nullable().optional()})});
const deliverySchema=z.object({webhookId:z.string().max(200),id:z.string().max(200),createdAt:z.iso.datetime(),type:z.literal("GRAPHQL"),event:z.object({network:z.string().optional(),sequenceNumber:z.string().regex(/^\d{1,40}$/),data:z.object({block:z.object({hash,number:integer,timestamp:integer,logs:z.array(logSchema).max(2000)})})})});
export type Delivery={webhookId:string;kind:WebhookKind;sequence:string;generation?:number;blockNumber:number;blockHash:string;timestamp:number;trades:OnchainTrade[]};
export function registeredPools(chainId:4663|8453,tokens:TokenRecord[]):SwapPool[]{
 const config={mode:chainId===4663?"robinhood" as const:"base" as const},assets=assetsFor(config);
 const pools:SwapPool[]=tokens.filter(t=>deploymentChain(t)===chainId).map(t=>{const quote=assets.find(a=>a.address.toLowerCase()===t.quoteAddress.toLowerCase());if(!quote)throw Error("Unknown registered quote asset");return {chainId,version:4,pool:t.poolId.toLowerCase(),token:t.address.toLowerCase(),quote:t.quoteAddress.toLowerCase(),tokenDecimals:18,quoteDecimals:quote.decimals,quoteSymbol:quote.symbol};});
 if(chainId===4663)pools.push({chainId,version:3,pool:MUSE_POOL,token:MUSEGOD.token.toLowerCase(),quote:MUSEGOD.weth.toLowerCase(),tokenDecimals:18,quoteDecimals:18,quoteSymbol:"WETH"});
 return pools.sort((a,b)=>a.pool.localeCompare(b.pool));
}
export function verifySignature(raw:string|Uint8Array,signature:string|undefined,key:string){
 if(!key||!signature||! /^[\da-f]{64}$/i.test(signature))return false;
 return timingSafeEqual(createHmac("sha256",key).update(raw).digest(),Buffer.from(signature,"hex"));
}
const abs=(v:bigint)=>v<0n?-v:v;
/** Integer arithmetic through division; the decimal string is the authoritative value. */
export function decimalRatio(n:bigint,d:bigint,precision=96){if(d<=0n||n<0n)throw Error("Invalid swap ratio");const scaled=n*10n**BigInt(precision)/d;return formatUnits(scaled,precision);}
export function decodeDelivery(raw:string,binding:{id:string;network:string;kind:WebhookKind},pools:SwapPool[]):Delivery{
 const body=deliverySchema.parse(JSON.parse(raw));if(body.webhookId!==binding.id||body.event.network&&body.event.network!==binding.network)throw Error("Webhook identity mismatch");
 const chainId:4663|8453|null=binding.network===NETWORKS[4663]?4663:binding.network===NETWORKS[8453]?8453:null;if(!chainId)throw Error("Webhook network mismatch");
 if(binding.kind!=='v3'&&binding.kind!=='v4'||chainId===8453&&binding.kind!=='v4')throw Error('Webhook kind mismatch');
 const block=body.event.data.block,logs=block.logs;
 if(block.timestamp>Math.floor(Date.now()/1000)+60||logs.length>2000)throw Error("Invalid block");
 const seen=new Set<number>();
 const trades=logs.map(log=>{
  if(seen.has(log.index))throw Error("Duplicate log index");seen.add(log.index);
  const v4=log.topics[0].toLowerCase()===V4_TOPIC,v3=log.topics[0].toLowerCase()===V3_TOPIC;
  if(binding.kind==='v4'?!v4:!v3)throw Error('Webhook kind mismatch');
  const pool=pools.find(p=>p.chainId===chainId&&(v4?p.version===4&&p.pool===log.topics[1].toLowerCase():v3&&p.version===3&&p.pool===log.account.address.toLowerCase()));
  const manager=contractsFor({mode:chainId===4663?"robinhood":"base",deploymentChainId:chainId}).poolManager;
  if(!pool||log.account.address.toLowerCase()!==(v4?manager.toLowerCase():pool.pool)||!(v4||v3))throw Error("Unregistered swap log");
  const args=decodeEventLog({abi:v4?abi4:abi3,data:log.data as Hex,topics:log.topics as [Hex,...Hex[]],strict:true}).args;
  const amount0=args.amount0,amount1=args.amount1,token0=pool.token.toLowerCase()<pool.quote.toLowerCase();
  const tokenAmount=token0?amount0:amount1,quoteAmount=token0?amount1:amount0;
  if(tokenAmount===0n||quoteAmount===0n||(tokenAmount>0n)===(quoteAmount>0n)||args.sqrtPriceX96===0n)throw Error("Invalid swap deltas");
  const hash=log.transaction.hash.toLowerCase(),id=`${chainId}:${hash}:${log.index}`;
  return {id,chainId,pool:pool.pool,hash,logIndex:log.index,blockNumber:block.number,blockHash:block.hash.toLowerCase(),at:new Date(block.timestamp*1000).toISOString(),account:log.transaction.from?.address.toLowerCase()??null,sender:args.sender.toLowerCase(),
   amount0:String(amount0),amount1:String(amount1),sqrtPriceX96:String(args.sqrtPriceX96),tick:args.tick,side:(v4?tokenAmount>0n:tokenAmount<0n)?"buy" as const:"sell" as const,
   amount:formatUnits(abs(tokenAmount),pool.tokenDecimals),quoteAmount:formatUnits(abs(quoteAmount),pool.quoteDecimals),
   priceQuote:decimalRatio(abs(quoteAmount)*10n**BigInt(pool.tokenDecimals),abs(tokenAmount)*10n**BigInt(pool.quoteDecimals)),quoteSymbol:pool.quoteSymbol,quoteAddress:pool.quote,source:"On-chain · Alchemy" as const};
 });
 return {webhookId:body.webhookId,kind:binding.kind,sequence:body.event.sequenceNumber,blockNumber:block.number,blockHash:block.hash.toLowerCase(),timestamp:block.timestamp,trades};
}
