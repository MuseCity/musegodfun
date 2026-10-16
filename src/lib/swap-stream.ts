import { z } from "zod";
const hash=z.string().regex(/^0x[\da-f]{64}$/i),address=z.string().regex(/^0x[\da-f]{40}$/i),integer=z.number().int().safe().nonnegative(),decimal=z.string().regex(/^\d+(?:\.\d+)?$/).max(180);
export const onchainTradeSchema=z.object({id:z.string().max(200),chainId:z.union([z.literal(4663),z.literal(8453)]),pool:z.string().regex(/^0x(?:[\da-f]{40}|[\da-f]{64})$/i),hash,logIndex:integer,blockNumber:integer,blockHash:hash,at:z.iso.datetime(),account:address.nullable(),sender:address.optional(),amount0:z.string().regex(/^-?\d{1,78}$/),amount1:z.string().regex(/^-?\d{1,78}$/),sqrtPriceX96:decimal,tick:z.number().int(),side:z.enum(["buy","sell"]),amount:decimal,quoteAmount:decimal,priceQuote:decimal,quoteSymbol:z.string().max(40),quoteAddress:address,source:z.literal("On-chain · Alchemy"),priceUsd:z.number().finite().positive().nullable().optional(),usd:z.number().finite().nonnegative().nullable().optional(),quoteUsd:z.object({price:z.number().finite().positive(),source:z.literal("LI.FI"),at:z.iso.datetime()}).nullable().optional()});
export type OnchainTrade=z.infer<typeof onchainTradeSchema>;
export type SwapMessage={type:"trades";chainId:4663|8453;pool:string;trades:OnchainTrade[];reorg:boolean;gap?:boolean;blockNumber:number;blockHash:string;coverageStart:string};
export function parseSwapMessage(raw:string,chainId:number,pool:string):SwapMessage|null{
 try {if(raw.length>1_048_576)return null;const schema=z.object({type:z.literal("trades"),chainId:z.number(),pool:z.string(),trades:z.array(onchainTradeSchema).max(2000),reorg:z.boolean(),gap:z.boolean().optional(),blockNumber:integer,blockHash:hash,coverageStart:z.iso.datetime()});const m=schema.parse(JSON.parse(raw));
 if(m.chainId!==chainId||m.pool!==pool||m.trades.some(t=>t.chainId!==chainId||t.pool!==pool||t.blockNumber!==m.blockNumber||t.blockHash!==m.blockHash||t.id!==`${chainId}:${t.hash}:${t.logIndex}`))return null;
 return m as SwapMessage;}catch{return null;}
}
