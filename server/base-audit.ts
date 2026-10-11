import type { Hex, PublicClient, Transport } from "viem";
import type { StoreBackend } from "./supabase-store";

/** Server-owned verified index state. These rows are never financial batches or public proof imports. */
export type BaseAuditStore = Pick<StoreBackend, "getBuybackBatch" | "compareAndSetBuybackAudit">;
type Anchor = { through: string; hash: Hex };
type AuditEntry = { blockNumber: string };
type Progress<T> = Anchor & { id: string; protocol: "internal_native_base_audit_v1"; version: 2; first: string; entries: T[];
  finalized?: Anchor };
const memory = new WeakMap<object, Map<string, Progress<unknown>>>();
const pending = new WeakMap<object, Map<string, Promise<unknown>>>();
const validHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const integer = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
type Client = Pick<PublicClient<Transport, any>, "getChainId" | "getBlock">;

/** Commits only complete canonical pages; callers must reject incomplete coverage before authorizing any spend. */
export async function readBaseAudit<T extends AuditEntry>(input: { client: Client; store?: BaseAuditStore; id: string; from: bigint; to: bigint;
  validate(value: unknown): value is T; page(from: bigint, to: bigint): Promise<T[]>; pageBlocks?: bigint;
  maxDurationMs?: number; now?: () => number }): Promise<T[]> {
  const { client, store, id, from, to } = input;
  const now = input.now ?? Date.now, duration = input.maxDurationMs ?? 9_000, pageBlocks = input.pageBlocks ?? 200n;
  if (!/^internal_native_[a-z_]+:0x[\da-f]{64}$/i.test(id) || from < 1n || to < from || await client.getChainId() !== 8453)
    throw new Error("Invalid canonical Base audit identity");
  if (!Number.isFinite(duration) || duration < 0 || duration > 60_000 || pageBlocks < 1n || pageBlocks > 200n)
    throw new Error("Invalid canonical Base audit time/page budget");
  const deadline = now() + duration;
  const byId = pending.get(client) ?? new Map(); pending.set(client, byId);
  // A same-head read may join; another head waits and then performs its own anchored increment.
  const requestKey = `${id}:${to}`;
  const running = byId.get(requestKey); if (running) return running as Promise<T[]>;
  const earlier = [...byId.entries()].filter(([key]) => key.startsWith(`${id}:`)).map(([, promise]) => promise);
  const work = (async () => {
    await Promise.allSettled(earlier);
    const map = memory.get(client) ?? new Map(); memory.set(client, map);
    const stored = store ? await store.getBuybackBatch(id) : map.get(id);
    let expected = stored ?? null;
    const validEntry = (value: unknown, first: bigint, last: bigint): value is T => input.validate(value) && integer(value.blockNumber) &&
      BigInt(value.blockNumber) >= first && BigInt(value.blockNumber) <= last;
    const anchor = (value: any) => integer(value?.through) && BigInt(value.through) >= from - 1n && validHash(value.hash);
    const baseShape = (value: any) => value?.id === id && value.protocol === "internal_native_base_audit_v1" && value.first === String(from) && anchor(value) && Array.isArray(value.entries);
    const valid = (value: any): value is Progress<T> => baseShape(value) && value.version === 2 && value.entries.every((row: unknown) => validEntry(row, from, BigInt(value.through))) &&
      (!value.finalized || integer(value.finalized.through) && BigInt(value.finalized.through) >= from - 1n && BigInt(value.finalized.through) <= BigInt(value.through) && validHash(value.finalized.hash));
    // Old complete snapshots retain their known watermark while awaiting a full
    // schema rescan. A partial/corrupt cache cannot manufacture a lagging-RPC gate.
    const validLegacy = (value: any) => baseShape(value) && value.version === 1 && value.entries.every(input.validate) &&
      (!value.finalized || anchor(value.finalized) && BigInt(value.finalized.through) <= BigInt(value.through) &&
        Array.isArray(value.finalized.entries) && value.finalized.entries.every(input.validate));
    let progress = valid(stored) ? stored : undefined;
    if ((progress || validLegacy(stored)) && BigInt(stored!.through) > to) throw new Error("Base audit RPC is behind retained canonical progress; pending");
    if (progress && (await client.getBlock({ blockNumber: BigInt(progress.through) })).hash !== progress.hash) {
      const stable = progress.finalized;
      progress = stable && (await client.getBlock({ blockNumber: BigInt(stable.through) })).hash === stable.hash ?
        { ...progress, ...stable, entries: progress.entries.filter(row => BigInt(row.blockNumber) <= BigInt(stable.through)), finalized: stable } : undefined;
    }
    if (!progress) {
      const anchor = await client.getBlock({ blockNumber: from - 1n });
      if (!validHash(anchor.hash)) throw new Error("Canonical Base audit initial anchor unavailable");
      progress = { id, protocol: "internal_native_base_audit_v1", version: 2, first: String(from), through: String(from - 1n), hash: anchor.hash, entries: [] };
    }
    const finalized = await client.getBlock({ blockTag: "finalized" }).catch(() => null);
    if (finalized?.number !== null && finalized?.number !== undefined && validHash(finalized.hash) &&
      (await client.getBlock({ blockNumber: finalized.number })).hash !== finalized.hash)
      throw new Error("Canonical Base audit finalized block changed; pending");
    const save = async (next: Progress<T>) => {
      if (store) {
        if (!await store.compareAndSetBuybackAudit(next, expected))
          throw new Error("Canonical Base audit changed concurrently; retry its canonical snapshot");
        expected = next;
      } else map.set(id, next);
    };
    const promote = async (next: Progress<T>): Promise<Progress<T>> => {
      if (!finalized || finalized.number === null || !validHash(finalized.hash)) return next;
      const target = finalized.number < BigInt(next.through) ? finalized.number : BigInt(next.through);
      if (target < from - 1n || next.finalized && target <= BigInt(next.finalized.through)) return next;
      const hash = target === BigInt(next.through) ? next.hash : (await client.getBlock({ blockNumber: target })).hash;
      if (!validHash(hash) || (await client.getBlock({ blockNumber: BigInt(next.through) })).hash !== next.hash ||
        (await client.getBlock({ blockNumber: target })).hash !== hash) throw new Error("Canonical Base audit finalized prefix changed; pending");
      return { ...next, finalized: { through: String(target), hash } };
    };
    // Finality advances even on a cache hit or a steady stream of tip-only pages.
    // A suffix conflict may discard only entries above this freshly anchored prefix.
    const promoted = await promote(progress);
    if (promoted !== progress) { progress = promoted; await save(progress); }
    while (BigInt(progress.through) < to && now() < deadline) {
      const first: bigint = BigInt(progress.through) + 1n, last: bigint = first + pageBlocks - 1n < to ? first + pageBlocks - 1n : to;
      const before = await client.getBlock({ blockNumber: last });
      if (!validHash(before.hash)) throw new Error("Canonical Base audit page anchor unavailable");
      const entries = await input.page(first, last);
      if (!entries.every(row => validEntry(row, first, last)) || (await client.getBlock({ blockNumber: BigInt(progress.through) })).hash !== progress.hash ||
        (await client.getBlock({ blockNumber: last })).hash !== before.hash) throw new Error("Canonical Base audit page changed; pending revalidation");
      progress = await promote({ ...progress, through: String(last), hash: before.hash, entries: [...progress.entries, ...entries] });
      // A finished page survives a later failing page and a cold process restart.
      await save(progress);
    }
    if (BigInt(progress.through) < to) throw new Error("Canonical Base audit coverage is incomplete; persisted progress will resume");
    if ((await client.getBlock({ blockNumber: to })).hash !== progress.hash) throw new Error("Canonical Base audit endpoint changed");
    return progress.entries;
  })();
  byId.set(requestKey, work);
  try { return await work; } finally { if (byId.get(requestKey) === work) byId.delete(requestKey); }
}
