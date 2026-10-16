import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { NotifyClient,desiredWebhook,webhookDiff } from "../server/alchemy-webhooks";
import { registeredPools } from "../server/swap-stream";
import type { TokenRecord } from "../src/lib/config";
/** Explicit local catalog input prevents an operator dry run from loading the application's .env or database. */
export async function runWebhookCli(args:string[],environment:Record<string,string|undefined>=process.env,fetcher:typeof fetch=fetch){
 const value=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
 const token=environment.ALCHEMY_NOTIFY_API_KEY;if(!token)throw Error("ALCHEMY_NOTIFY_API_KEY is required");
 const file=value('--tokens');if(!file)throw Error("Supply --tokens <registered-token-catalog.json>; default is read-only");
 const tokens:TokenRecord[]=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(tokens))throw Error("Invalid token catalog");
 const origin=value('--origin')??'https://musegod.fun';if(!/^https:\/\/(?:musegod\.fun|www\.musegod\.fun)$/.test(origin))throw Error("Expected the canonical production origin");
 const hooks=await new NotifyClient(token,fetcher).list();
 const diff=([4663,8453] as const).map(id=>{const pools=registeredPools(id,tokens),desired=desiredWebhook(id,pools,`${origin}/api/chains/${id}/webhooks/alchemy`);return {chainId:id,poolCount:pools.length,...(pools.length?webhookDiff(hooks,desired):{action:'idle',network:desired.network}),query:desired.graphql_query};});
 if(args.includes('--apply'))for(const d of diff){const response=await fetcher(`${origin}/api/chains/${d.chainId}/webhooks/alchemy/reconcile`,{method:'POST',headers:{Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(30_000)});if(!response.ok)throw Error(`Runtime reconciliation rejected (${response.status})`);}
 // Never return raw Notify records: list/create responses contain signing keys.
 return {mode:args.includes('--apply')?'apply':'dry-run',webhooks:hooks.map(h=>({id:h.id,network:h.network,url:h.webhook_url,active:h.is_active})),diff};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runWebhookCli(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(()=>{console.error("Webhook operator command failed; check token, catalog and runtime availability.");process.exitCode=1;});
