import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadEnvironment, runtimeFromEnv } from "../server/config";
import { SupabaseStore } from "../server/supabase-store";
import { Store } from "../server/store";

export async function runtimeControlCommand(args: string[]) {
  const [operation, network, revision, ...reason] = args;
  if (!["status","pause","resume"].includes(operation) || !["4663","8453"].includes(network))
    throw new Error("Usage: tsx scripts/runtime-control.ts status|pause|resume 4663|8453 [expected-revision reason]");
  const runtime=runtimeFromEnv(Number(network) as 4663|8453);
  const store=runtime.supabase ? new SupabaseStore(runtime.supabase.url,runtime.supabase.secretKey,runtime.dataScope)
    : new Store(runtime.dataDir,runtime.config.chainId);
  try {
    if(operation === "status")return await store.runtimeControl();
    if(!revision || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)) || !reason.length)
      throw new Error("A current revision and an audit reason are required; read status first.");
    return await store.updateRuntimeControl(operation === "pause",reason.join(" "),Number(revision));
  } finally {await store.close();}
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadEnvironment();
  try {console.log(JSON.stringify(await runtimeControlCommand(process.argv.slice(2)),null,2));}
  catch(error) {console.error(error instanceof Error ? error.message : "Runtime control operation failed");process.exitCode=1;}
}
