import { isIP } from "node:net";
import { BudgetUnavailable } from "./runtime-policy";

export function clientBucket(raw: string): string {
  const value = raw.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
  if (isIP(value) !== 6) return isIP(value) === 4 ? value : "unknown";
  const [left, right = ""] = value.toLowerCase().split("::");
  const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
  const words = [...a, ...Array(Math.max(0, 8-a.length-b.length)).fill("0"), ...b];
  return words.slice(0, 4).map(word => parseInt(word, 16).toString(16)).join(":") + "::/64";
}
export const expensiveRoute = (path: string) => /\/(?:launch\/(?:prepare|simulate)|first-buy\/(?:prices|quote)|token-images)$/.test(path.split("?")[0].replace(/\/+$/, "").toLowerCase());
type Row = { at: number; count: number; expensive: number; active: number; riskTimes: number[]; uploadTimes: number[] };
export class IngressLimiter {
  private readonly rows = new Map<string, Row>();
  private active = 0;
  admit(ip: string, path: string, now = Date.now()): { status?: number; challenge: boolean; release(): void } {
    const key = clientBucket(ip);
    let row = this.rows.get(key);
    if (!row || now-row.at >= 60_000) row = {at:now,count:0,expensive:0,active:row?.active ?? 0,
      riskTimes: row?.riskTimes ?? [], uploadTimes: row?.uploadTimes ?? []};
    this.rows.delete(key); this.rows.set(key,row);
    while (this.rows.size > 10_000) {
      const oldest = this.rows.keys().next().value!;
      if (oldest === key) break;
      this.rows.delete(oldest);
    }
    row.count++;
    if (expensiveRoute(path)) row.expensive++;
    const normalized = path.split("?")[0].replace(/\/+$/, "").toLowerCase();
    const workflow = /\/(?:launch\/(?:prepare|simulate)|first-buy\/quote)$/.test(normalized);
    const upload = normalized.endsWith("/token-images");
    row.riskTimes = row.riskTimes.filter((time) => time > now - 300_000);
    row.uploadTimes = row.uploadTimes.filter((time) => time > now - 300_000);
    if (workflow) row.riskTimes.push(now);
    if (upload) row.uploadTimes.push(now);
    const challenge = workflow && (row.riskTimes.filter((time) => time > now - 60_000).length > 16 || row.riskTimes.length > 40) ||
      upload && row.uploadTimes.length > 6;
    // Keep the risk history bounded independently of request admission.
    row.riskTimes = row.riskTimes.slice(-41); row.uploadTimes = row.uploadTimes.slice(-7);
    // Per-source limits precede the shared cap, including before body reads.
    if (row.count > 180 || row.expensive > 20 || row.active >= 4)
      return {status:429,challenge,release() {}};
    if (this.active >= 32) return {status:503,challenge,release() {}};
    row.active++; this.active++;
    let done = false;
    return {challenge,release:()=>{if (!done) {done=true;row!.active--;this.active--;}}};
  }
}
export class PreviewQueue {
  private active = 0;
  private readonly queue: (()=>void)[] = [];
  private readonly pending = new Map<string,Promise<unknown>>();
  private readonly completed = new Map<string,{at:number;result:unknown}>();
  async run<T>(key: string, task: ()=>Promise<T>, requestKey?: string): Promise<T> {
    const now=Date.now();
    for(const [key,row] of this.completed)if(now-row.at>=300_000)this.completed.delete(key);
    const prior=requestKey ? this.completed.get(requestKey) : undefined;
    if(prior)return prior.result as T;
    let work = this.pending.get(key) as Promise<T> | undefined;
    if(!work) {
      work = (async()=>{
      if (this.active >= 4) {
        if (this.queue.length >= 8) throw new BudgetUnavailable(2);
        await new Promise<void>((resolve,reject)=>{
          const ready=()=>{clearTimeout(timer);this.active++;resolve();};
          const timer=setTimeout(()=>{const i=this.queue.indexOf(ready);if(i>=0)this.queue.splice(i,1);reject(new BudgetUnavailable(2));},2_000);
          this.queue.push(ready);
        });
      } else this.active++;
      try {return await task();} finally {this.active--;this.queue.shift()?.();}
      })();
      this.pending.set(key,work);
      void work.finally(()=>this.pending.delete(key)).catch(()=>{});
    }
    const result=await work;
    if(requestKey) {
      if(this.completed.size>=128)this.completed.delete(this.completed.keys().next().value!);
      this.completed.set(requestKey,{at:Date.now(),result});
    }
    return result;
  }
}
export class RiskChallenge {
  private readonly passed = new Map<string,number>();
  async verify(ip: string, token: string|undefined, secret: string|undefined, hostname: string, now=Date.now()): Promise<boolean> {
    const key=clientBucket(ip);
    if ((this.passed.get(key)??0)>now) return true;
    for(const [k,expires] of this.passed) if(expires<=now)this.passed.delete(k);
    if (!secret || !token || token.length > 2048) return false;
    try {
      const response=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {method:"POST",redirect:"manual",headers:{"content-type":"application/json"},body:JSON.stringify({secret,response:token,remoteip:ip}),signal:AbortSignal.timeout(10_000)});
      if(!response.ok)return false;
      const result=await response.json() as {success?:boolean;hostname?:string;action?:string};
      if(result.success!==true || result.hostname!==hostname || result.action!=="expensive_request")return false;
      if(this.passed.size>=10_000)this.passed.delete(this.passed.keys().next().value!);
      this.passed.set(key,now+300_000);return true;
    } catch {return false;}
  }
}
