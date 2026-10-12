import { keccak256, stringToHex } from "viem";
import type { StoreBackend } from "./supabase-store";

export type ContractIdentityStore = Pick<StoreBackend, "getBuybackBatch" | "compareAndSetBuybackAudit">;
const protocol = "internal_native_contract_identity_v1";
const identities = new WeakMap<object, Map<string, Promise<unknown>>>();
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([, item]) => item !== undefined).map(([key, item]) => [key, canonical(item)]));
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Immutable identity requires JSON metadata");
}
const fingerprint = (value: unknown) => keccak256(stringToHex(JSON.stringify(canonical(value))));

/** Private, manifest/code-bound immutable identity only. Balances, pause state,
 * governance permissions and transaction inputs must stay in live readers. */
export async function contractIdentityOnce<T>(client: object, input: {
  namespace: string; binding: unknown; store?: ContractIdentityStore;
  verify: () => Promise<T>; validate: (value: unknown) => boolean;
}): Promise<T> {
  if (!/^[a-z0-9_]{1,48}$/.test(input.namespace)) throw new Error("Invalid immutable identity namespace");
  const binding = fingerprint({ namespace: input.namespace, identity: input.binding }), id = `${protocol}:${binding}`;
  const owner = input.store ?? client;
  let cache = identities.get(owner);
  if (!cache) { cache = new Map(); identities.set(owner, cache); }
  const retained = cache.get(id);
  if (retained) return structuredClone(await retained) as T;
  const accepted = (row: Record<string, unknown> | null) => row?.id === id && row.protocol === protocol && row.version === 1 && row.binding === binding &&
    row.status === "verified" && typeof row.verifiedAt === "number" && Number.isSafeInteger(row.verifiedAt) && row.verifiedAt >= 0 &&
    input.validate(row.value) && row.valueHash === fingerprint(row.value);
  const work = (async () => {
    const previous = input.store ? await input.store.getBuybackBatch(id) : null;
    if (accepted(previous)) return previous!.value as T;
    const value = canonical(await input.verify()) as T;
    if (!input.validate(value)) throw new Error("Immutable identity verification returned invalid metadata");
    if (input.store) {
      const next = { id, protocol, version: 1, status: "verified", binding, value, valueHash: fingerprint(value), verifiedAt: Date.now() };
      if (!await input.store.compareAndSetBuybackAudit(next, previous)) {
        const winner = await input.store.getBuybackBatch(id);
        if (!accepted(winner)) throw new Error("Immutable identity record changed; retry verification");
        return winner!.value as T;
      }
    }
    return value;
  })();
  cache.set(id, work);
  try { return structuredClone(await work) as T; }
  catch (error) { if (cache.get(id) === work) cache.delete(id); throw error; }
}
