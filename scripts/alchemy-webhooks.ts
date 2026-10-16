import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { NotifyClient,NotifyUnavailable,desiredWebhook,webhookDiff,webhookKinds } from "../server/alchemy-webhooks";
import { registeredPools } from "../server/swap-stream";
import { deploymentChain,type TokenRecord } from "../src/lib/config";
import { z } from "zod";
/** Explicit local catalog input prevents an operator dry run from loading the application's .env or database. */
export async function runWebhookCli(args:string[],environment:Record<string,string|undefined>=process.env,fetcher:typeof fetch=(input,init)=>fetch(input,init)){
 if(args.includes('--apply'))throw Error('Webhook operator is read-only; reconciliation belongs to the chain alarm');
 const value=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
 const token=environment.ALCHEMY_NOTIFY_API_KEY;if(!token)throw Error("ALCHEMY_NOTIFY_API_KEY is required");
 const file=value('--tokens');if(!file)throw Error("Supply --tokens <registered-token-catalog.json>; default is read-only");
 const tokens:TokenRecord[]=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(tokens))throw Error("Invalid token catalog");
 const origin=value('--origin')??'https://musegod.fun';if(!/^https:\/\/(?:musegod\.fun|www\.musegod\.fun)$/.test(origin))throw Error("Expected the canonical production origin");
 const hooks=await new NotifyClient(token,fetcher).list();
 const diff=([4663,8453] as const).flatMap(id=>{const chainTokens=tokens.filter(t=>deploymentChain(t)===id),pools=chainTokens.length?registeredPools(id,chainTokens):[];return webhookKinds(id).map(kind=>{if(!chainTokens.length)return {chainId:id,kind,poolCount:0,action:'skipped (not in catalog)'};const selected=pools.filter(p=>p.version===(kind==='v4'?4:3)),desired=desiredWebhook(id,selected,`${origin}/api/chains/${id}/webhooks/alchemy`,kind);return {chainId:id,kind,poolCount:selected.length,...(selected.length?webhookDiff(hooks,desired):{action:'idle',network:desired.network,url:desired.webhook_url}),query:desired.graphql_query};});});
 // Never return raw Notify records: list/create responses contain signing keys.
 return {mode:'dry-run',webhooks:hooks.map(h=>({id:h.id,network:h.network,url:h.webhook_url,active:h.is_active})),diff};
}
/** Only known local reasons escape; arbitrary transport, JSON/schema details and paths can contain credentials. */
export function webhookCliError(error:unknown){
 const message=error instanceof Error?error.message:'',code=(error as NodeJS.ErrnoException|null)?.code;
 const known=['Webhook operator is read-only; reconciliation belongs to the chain alarm','ALCHEMY_NOTIFY_API_KEY is required','Supply --tokens <registered-token-catalog.json>; default is read-only','Invalid token catalog','Expected the canonical production origin','Unknown registered quote asset','Invalid registered pool id','Notify response invalid'];
 const reason=error instanceof NotifyUnavailable?'Notify request timed out or could not connect':error instanceof SyntaxError?'Token catalog is not valid JSON':error instanceof z.ZodError?'Notify response schema is invalid':code==='ENOENT'?'Token catalog file not found':code==='EACCES'||code==='EPERM'?'Token catalog file is not readable':known.includes(message)||/^Notify request rejected \(\d{3}\)$/.test(message)?message:'Unexpected catalog or provider failure';
 return `Webhook operator command failed: ${reason}.`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runWebhookCli(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(webhookCliError(error));process.exitCode=1;});
