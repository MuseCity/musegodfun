import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";

type Input = { path: string; chainId: number; keeper: Address; balanceWei: bigint; typicalReservationWei: bigint; now?: number };
type Observation = { version: 1; chainId: number; keeper: Address; low: boolean; typicalReservationWei: string; updatedAt: number };
const pending = new Map<string,Promise<void>>();
const maxUint = 2n ** 256n - 1n;

function stdout(value: unknown) { try { console.log(JSON.stringify(value)); } catch { /* Alert IO must never stop financial work. */ } }
async function saveObservation(path: string, value: Observation) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    file = await open(temporary,"wx",0o600);
    await file.writeFile(JSON.stringify(value)+"\n"); await file.sync(); await file.close(); file=undefined;
    await rename(temporary,path);
    const directory=await open(dirname(path),"r");try{await directory.sync();}finally{await directory.close();}
  } finally { await file?.close(); await unlink(temporary).catch(()=>undefined); }
}

async function observe(input: Input, path: string, keeper: Address, now: number) {
  const statePath=`${path}.balance.json`, identity={chainId:input.chainId,keeper};
  const warning=()=>stdout({state:"keeper_balance_alert_pending",...identity,at:now,
    reason:"Balance alert persistence is unavailable; financial execution is unchanged."});
  let previous: Observation | undefined;
  try {
    const value=JSON.parse(await readFile(statePath,"utf8"));
    if(value?.version===1 && value.chainId===input.chainId && typeof value.keeper==="string" &&
      value.keeper.toLowerCase()===keeper.toLowerCase() && typeof value.low==="boolean" &&
      Number.isSafeInteger(value.updatedAt) && value.updatedAt>=0 && typeof value.typicalReservationWei==="string" &&
      /^[1-9]\d{0,77}$/.test(value.typicalReservationWei) && BigInt(value.typicalReservationWei)<=maxUint) previous=value;
  } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")warning(); }
  const typical=input.typicalReservationWei>0n?input.typicalReservationWei:previous?BigInt(previous.typicalReservationWei):0n;
  if(typical===0n)return; // No measured reservation: never invent a typical fee.
  const low=input.balanceWei<3n*typical, next:Observation={version:1,...identity,low,typicalReservationWei:String(typical),updatedAt:now};
  if(previous?.low===low && previous.typicalReservationWei===next.typicalReservationWei)return;
  if(low && !previous?.low) {
    const alert={state:"keeper_balance_low",...identity,at:now,balanceWei:String(input.balanceWei),
      typicalReservationWei:String(typical),thresholdWei:String(3n*typical)};
    // Publish to stdout even when the local append fails. Only a synced append
    // may mark this episode as delivered; a failed write remains retryable.
    stdout(alert);
    try {
      await mkdir(dirname(path),{recursive:true,mode:0o700});
      const file=await open(path,"a",0o600);
      try { await file.chmod(0o600); await file.writeFile(JSON.stringify(alert)+"\n"); await file.sync(); }
      finally { await file.close(); }
    } catch {
      warning();
      // Retain a real new estimate for an idle retry without claiming that the
      // alert was delivered. This cache carries no financial authorization.
      try { await saveObservation(statePath,{...next,low:false}); } catch { warning(); }
      return;
    }
  }
  try { await saveObservation(statePath,next); } catch { warning(); }
}

/** Notification only: callers supply a real complete gas reservation already
 * observed by their financial path. No estimates, RPCs, budgets or permissions
 * are changed here. Existing keeper leases provide the cross-process writer lock. */
export async function monitorKeeperBalance(input: Input): Promise<void> {
  if(!input || typeof input.path!=="string" || !input.path.trim() || !Number.isSafeInteger(input.chainId) || input.chainId<=0 ||
    typeof input.keeper!=="string" || !isAddress(input.keeper,{strict:false}) || input.keeper.toLowerCase()===zeroAddress ||
    typeof input.balanceWei!=="bigint" || input.balanceWei<0n || input.balanceWei>maxUint ||
    typeof input.typicalReservationWei!=="bigint" || input.typicalReservationWei<0n || input.typicalReservationWei>maxUint) return;
  const now=input.now ?? Date.now();if(!Number.isSafeInteger(now)||now<0)return;
  const path=resolve(input.path),keeper=getAddress(input.keeper);
  // A cycle can examine several tasks concurrently. Serialize only this local
  // observation file so one low-balance episode does not generate duplicates.
  const work=(pending.get(path) ?? Promise.resolve()).then(()=>observe(input,path,keeper,now)).catch(()=>
    stdout({state:"keeper_balance_alert_pending",chainId:input.chainId,keeper,at:now,
      reason:"Balance alert persistence is unavailable; financial execution is unchanged."}));
  pending.set(path,work);
  try { await work; } finally { if(pending.get(path)===work)pending.delete(path); }
}
