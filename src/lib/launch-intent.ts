import type { Address, Hash } from "viem";
import { deploymentChain, type RuntimeConfig } from "./config";
import { transactions, transactionMatchesConfig } from "./transactions";
import type { LaunchPlan } from "./launch-plan";
import { quoteNow } from "./quote-clock";

export function validIntentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}
export function newIntentId() { return crypto.randomUUID(); }
function scope(config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId">, account?: Address | null) {
  return `${config.chainId}.${deploymentChain(config)}.${account?.toLowerCase() ?? "draft"}`;
}
export function activeLaunchIntent(config: RuntimeConfig, account?: Address | null): string {
  const key = `musegod.launch.intent.${scope(config, account)}`;
  const saved = localStorage.getItem(key);
  if (validIntentId(saved)) return saved;
  const intent = newIntentId();
  localStorage.setItem(key, intent);
  return intent;
}
export function selectLaunchIntent(config: RuntimeConfig, account: Address | null, intent: string) {
  if (!validIntentId(intent)) throw new Error("Invalid launch intent");
  localStorage.setItem(`musegod.launch.intent.${scope(config, account)}`, intent);
}
export function launchIntentStorageKey(config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId">, account: Address | null, intent: string, kind: "draft" | "pending" | "payment" | "plan" | "submission") {
  if (!validIntentId(intent)) throw new Error("Invalid launch intent");
  return `musegod.launch.${kind}.${scope(config, account)}.${intent}`;
}
export function restoreLegacyPending(config: RuntimeConfig, account: Address | null, intent: string): Hash | null {
  const key = launchIntentStorageKey(config, account, intent, "pending");
  const existing = localStorage.getItem(key);
  if (existing && /^0x[\da-f]{64}$/i.test(existing)) return existing as Hash;
  const oldKey = `musegod.pending.launch.${config.chainId}${config.mode === "fork" ? `.${deploymentChain(config)}` : ""}`;
  const old = localStorage.getItem(oldKey);
  if (!old || !account) return null;
  const row = transactions().find((tx) => tx.hash.toLowerCase() === old.toLowerCase() && tx.account.toLowerCase() === account.toLowerCase() && transactionMatchesConfig(tx, config));
  if (!row) return null;
  localStorage.setItem(key, old);
  localStorage.removeItem(oldKey);
  return old as Hash;
}
export function saveFrozenLaunch(config: RuntimeConfig, account: Address, plan: LaunchPlan) {
  if (!plan.intentId) return;
  localStorage.setItem(launchIntentStorageKey(config, account, plan.intentId, "plan"), JSON.stringify(plan));
}
/** This browser sent a launch for a token the catalog does not list yet. A
 * review-time plan backup alone is not evidence: it exists before any send. */
export function sentLaunchAwaitingRegistration(config: Pick<RuntimeConfig, "chainId" | "mode" | "deploymentChainId">, tokenAddress: string): boolean {
  try {
    // A sped-up (repriced) launch is saved as its own pending row with the same token.
    return transactions().some((tx) => tx.action === "launch" && !tx.registered && ["pending", "success"].includes(tx.status) &&
      tx.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase() && transactionMatchesConfig(tx, config));
  } catch { return false; }
}
export function savedLaunchIntents(config: RuntimeConfig, account: Address | null) {
  const prefix = `musegod.launch.draft.${scope(config, account)}.`;
  const saved: { intentId: string; name: string; pending: boolean }[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const intentId = key.slice(prefix.length);
    if (!validIntentId(intentId)) continue;
    try {
      const draft = JSON.parse(localStorage.getItem(key) || "null");
      saved.push({ intentId, name: typeof draft?.name === "string" && draft.name.trim() ? draft.name : "Untitled token",
        pending: !!localStorage.getItem(launchIntentStorageKey(config, account, intentId, "submission")) ||
          !!localStorage.getItem(launchIntentStorageKey(config, account, intentId, "pending")) });
    } catch { /* Damaged unsigned drafts do not authorize recovery. */ }
  }
  return saved;
}
// IndexedDB read/write transactions serialize across same-origin tabs. A plain
// localStorage read/write lease is not atomic and must never authorize a send.
const LEASE_MS = 120_000, RENEW_MS = 30_000;
const LOCK_ERROR = "A reliable cross-tab launch lock is unavailable. Keep this draft and reopen it in a supported browser before sending.";
type Lease = { key: string; owner: string; expires: number };
type HeldLock = { owner: string; lost: boolean; check: () => Promise<void> };
const heldLocks = new Map<string, HeldLock>();
async function leaseDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error(LOCK_ERROR);
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open("musegod-launch-locks", 1);
    const timer = setTimeout(() => { settled = true; reject(new Error(LOCK_ERROR)); }, 3_000);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("leases")) request.result.createObjectStore("leases", { keyPath: "key" }); };
    request.onsuccess = () => { clearTimeout(timer); if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
    request.onerror = () => { clearTimeout(timer); settled = true; reject(new Error(LOCK_ERROR)); };
    request.onblocked = () => { clearTimeout(timer); settled = true; reject(new Error(LOCK_ERROR)); };
  });
}
async function changeLease(db: IDBDatabase, key: string, owner: string, action: "acquire" | "renew" | "release") {
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction("leases", "readwrite"), store = tx.objectStore("leases"), request = store.get(key);
    let allowed = false;
    request.onsuccess = () => {
      const lease = request.result as Lease | undefined, now = quoteNow();
      if (action === "release") {
        if (lease?.owner === owner) { store.delete(key); allowed = true; }
      } else if (action === "acquire" ? !lease || lease.expires <= now : lease?.owner === owner && lease.expires > now) {
        store.put({ key, owner, expires: now + LEASE_MS } satisfies Lease); allowed = true;
      }
    };
    tx.oncomplete = () => resolve(allowed);
    tx.onerror = tx.onabort = () => reject(new Error(LOCK_ERROR));
  });
}
/** Call inside the actual-send gate. A suspended tab must not resume signing
 * after its IndexedDB lease expired or was acquired by a different tab. */
export async function assertLaunchIntentLock(config: RuntimeConfig, account: Address, intent: string) {
  const held = heldLocks.get(launchIntentStorageKey(config, account, intent, "submission"));
  if (!held || held.lost) throw new Error("This launch lock expired or changed. Reopen the saved draft before sending.");
  await held.check();
  if (held.lost) throw new Error("This launch lock expired or changed. Reopen the saved draft before sending.");
}
// The persistent submission marker is deliberately separate from the lease:
// a crashed/unknown broadcast remains blocked after the lease itself expires.
export async function withLaunchIntentLock<T>(config: RuntimeConfig, account: Address, intent: string,
  operation: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T> {
  const key = launchIntentStorageKey(config, account, intent, "submission"), owner = newIntentId();
  if (heldLocks.has(key)) throw new Error("This launch is already being submitted in this tab.");
  const run = async (held: HeldLock) => {
    if (localStorage.getItem(key)) throw new Error("This launch is being submitted or needs recovery. You can create another token while it is checked.");
    heldLocks.set(key, held);
    try { return await operation(() => assertLaunchIntentLock(config, account, intent)); }
    finally { if (heldLocks.get(key) === held) heldLocks.delete(key); }
  };
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request(key, { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error("This launch is open in another tab. You can create another token.");
      return run({ owner, lost: false, check: async () => {} });
    });
  const db = await leaseDatabase();
  try {
    if (!await changeLease(db, key, owner, "acquire")) throw new Error("This launch is open in another tab. You can create another token.");
    let renewal: Promise<void> | undefined;
    const held: HeldLock = { owner, lost: false, check: async () => {
      if (!await changeLease(db, key, owner, "renew")) held.lost = true;
    } };
    const timer = setInterval(() => {
      if (!renewal) renewal = held.check().catch(() => { held.lost = true; }).finally(() => { renewal = undefined; });
    }, RENEW_MS);
    try { return await run(held); }
    finally {
      clearInterval(timer); await renewal;
      await changeLease(db, key, owner, "release").catch(() => {});
    }
  } finally { db.close(); }
}
