import { keccak256, stringToHex, type Hex, type PublicClient, type Transport } from "viem";
import type { BaseCollectorManifest } from "./base-collector";
import type { BaseAuditStore } from "./base-audit";
import { BASE_NATIVE_DESTINATION_POLICY } from "../src/lib/base-buyback";

type Client = Pick<PublicClient<Transport, any>, "getChainId" | "getBlock">;
export type BaseActivationBlock = { number: bigint; hash: Hex };
export type BaseActivationAnchors = { source: BaseActivationBlock[]; destination: BaseActivationBlock[] };
export type BaseActivationHeads = { source: BaseActivationBlock; destination: BaseActivationBlock };
type StoredBlock = { number: string; hash: Hex };
type StoredPair = { source: StoredBlock; destination: StoredBlock };
type ActivationRecord = { id: string; protocol: "internal_native_activation_v1"; version: 1; binding: Hex;
  destinationPolicy: typeof BASE_NATIVE_DESTINATION_POLICY;
  graphFingerprint: Hex; sourceChainId: 8453; destinationChainId: 4663;
  anchors: { source: StoredBlock[]; destination: StoredBlock[] }; finalized: StoredPair; verifiedAt: number };
const chains = ["source", "destination"] as const;
const isHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const isNumber = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const pending = () => new Error("The finalized Base activation record is unavailable or changed; explicit operator verification is required");
const lower = (value: Hex) => value.toLowerCase() as Hex;

// The full acceptance proof is bound independently of object key order and hex case.
function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (object(entry)) return Object.fromEntries(Object.keys(entry).sort().filter(key => entry[key] !== undefined).map(key => [key, normalize(entry[key])]));
    if (typeof entry === "string") return /^0x[\da-f]*$/i.test(entry) ? entry.toLowerCase() : entry;
    if (entry === null || typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry)) return entry;
    throw pending();
  };
  return JSON.stringify(normalize(value));
}

export function activationRecordIdentity(manifest: BaseCollectorManifest, graphFingerprint: Hex) {
  if (manifest.chainId !== 8453 || !isHash(graphFingerprint) || !object(manifest.activation)) throw pending();
  const binding = keccak256(stringToHex(canonical({ protocol: "internal_native_activation_v1", version: 1,
    sourceChainId: 8453, destinationChainId: 4663, destinationPolicy: BASE_NATIVE_DESTINATION_POLICY,
    graphFingerprint, activation: manifest.activation, canaryAuthorization: manifest.canaryAuthorization ?? null })));
  return { id: `internal_native_activation:${binding}`, binding, graphFingerprint: lower(graphFingerprint) };
}

function parseBlock(value: unknown): StoredBlock {
  if (!object(value) || !isNumber(value.number) || !isHash(value.hash)) throw pending();
  return { number: value.number, hash: lower(value.hash) };
}

function storedBlock(value: BaseActivationBlock): StoredBlock {
  if (!value || typeof value.number !== "bigint" || value.number < 0n || value.number >= 2n ** 256n || !isHash(value.hash)) throw pending();
  return { number: String(value.number), hash: lower(value.hash) };
}

function parseAnchors(value: unknown): ActivationRecord["anchors"] {
  if (!object(value) || chains.some(chain => !Array.isArray(value[chain]) || value[chain].length === 0) ||
    (value.source as unknown[]).length + (value.destination as unknown[]).length > 160) throw pending();
  const result = { source: (value.source as unknown[]).map(parseBlock), destination: (value.destination as unknown[]).map(parseBlock) };
  for (const chain of chains) if (new Set(result[chain].map(block => block.number)).size !== result[chain].length) throw pending();
  return result;
}

function parseRecord(value: unknown, identity: ReturnType<typeof activationRecordIdentity>): ActivationRecord {
  if (!object(value) || value.id !== identity.id || value.protocol !== "internal_native_activation_v1" || value.version !== 1 ||
    value.destinationPolicy !== BASE_NATIVE_DESTINATION_POLICY ||
    !isHash(value.binding) || value.binding !== identity.binding || value.graphFingerprint !== identity.graphFingerprint || value.sourceChainId !== 8453 || value.destinationChainId !== 4663 ||
    !Number.isSafeInteger(value.verifiedAt) || Number(value.verifiedAt) <= 0 || !object(value.finalized)) throw pending();
  const anchors = parseAnchors(value.anchors), finalized = { source: parseBlock(value.finalized.source), destination: parseBlock(value.finalized.destination) };
  if (chains.some(chain => anchors[chain].some(anchor => BigInt(anchor.number) > BigInt(finalized[chain].number)))) throw pending();
  return { id: identity.id, protocol: "internal_native_activation_v1", version: 1, binding: identity.binding,
    destinationPolicy: BASE_NATIVE_DESTINATION_POLICY,
    graphFingerprint: identity.graphFingerprint, sourceChainId: 8453, destinationChainId: 4663, anchors, finalized, verifiedAt: Number(value.verifiedAt) };
}

async function canonicalAnchors(source: Client, destination: Client, anchors: ActivationRecord["anchors"], heads: StoredPair,
  retained?: StoredPair): Promise<StoredPair> {
  const clients = { source, destination };
  try {
    if (await source.getChainId() !== 8453 || await destination.getChainId() !== 4663) throw pending();
    const finalized = await Promise.all(chains.map(async chain => {
      const client = clients[chain], block = await client.getBlock({ blockTag: "finalized" });
      if (block.number === null || !isHash(block.hash)) throw pending();
      const stable = storedBlock({ number: block.number, hash: block.hash }), head = heads[chain];
      if (BigInt(stable.number) > BigInt(head.number) || retained && BigInt(stable.number) < BigInt(retained[chain].number) ||
        anchors[chain].some(anchor => BigInt(anchor.number) > BigInt(stable.number) || BigInt(anchor.number) + 64n > BigInt(head.number))) throw pending();
      const checks = [head, stable, ...anchors[chain], ...(retained ? [retained[chain]] : [])];
      await Promise.all(checks.map(async expected => {
        const actual = await client.getBlock({ blockNumber: BigInt(expected.number) });
        if (actual.number !== BigInt(expected.number) || !isHash(actual.hash) || lower(actual.hash) !== expected.hash) throw pending();
      }));
      const freshHead = await client.getBlock({ blockNumber: BigInt(head.number) });
      if (await client.getChainId() !== (chain === "source" ? 8453 : 4663) || freshHead.number !== BigInt(head.number) ||
        !isHash(freshHead.hash) || lower(freshHead.hash) !== head.hash) throw pending();
      return stable;
    }));
    return { source: finalized[0], destination: finalized[1] };
  } catch { throw pending(); }
}

/** Call only after explicit full operator acceptance succeeds. The private store is trusted server metadata, not a cryptographic seal. */
export async function persistBaseActivationRecord(source: Client, destination: Client, store: BaseAuditStore, manifest: BaseCollectorManifest,
  graphFingerprint: Hex, anchors: BaseActivationAnchors, heads: BaseActivationHeads): Promise<void> {
  const identity = activationRecordIdentity(manifest, graphFingerprint);
  if (manifest.activation.status !== "canary_verified" || !manifest.activation.nativeExecution || !manifest.canaryAuthorization ||
    !manifest.activation.walletAcceptance || !manifest.activation.pauseRollbackAcceptance || !manifest.activation.nativeRunAcceptance) throw pending();
  const captured = parseAnchors({ source: anchors.source.map(storedBlock), destination: anchors.destination.map(storedBlock) });
  const headPair = { source: storedBlock(heads.source), destination: storedBlock(heads.destination) };
  try {
    const expected = await store.getBuybackBatch(identity.id) ?? null;
    const finalized = await canonicalAnchors(source, destination, captured, headPair);
    // Issuance consumes this completed private record without another RPC
    // audit. Finish every canonical check before exposing it to that reader.
    await canonicalAnchors(source, destination, captured, headPair, finalized);
    const record: ActivationRecord = { ...identity, protocol: "internal_native_activation_v1", version: 1, sourceChainId: 8453, destinationChainId: 4663,
      destinationPolicy: BASE_NATIVE_DESTINATION_POLICY,
      anchors: captured, finalized, verifiedAt: Date.now() };
    if (!await store.compareAndSetBuybackAudit(record, expected)) throw pending();
  } catch { throw pending(); }
}

/** Reuses finalized acceptance across process restarts; never fetches old receipts, logs, or traces. */
export async function assertBaseActivationRecord(source: Client, destination: Client, store: BaseAuditStore, manifest: BaseCollectorManifest,
  graphFingerprint: Hex, heads: BaseActivationHeads): Promise<void> {
  const identity = activationRecordIdentity(manifest, graphFingerprint), headPair = { source: storedBlock(heads.source), destination: storedBlock(heads.destination) };
  try {
    const record = parseRecord(await store.getBuybackBatch(identity.id), identity);
    await canonicalAnchors(source, destination, record.anchors, headPair, record.finalized);
  } catch { throw pending(); }
}

/** Issuance uses the already completed private acceptance only. Live keeper
 * authority and canonical anchors are checked separately before fee spending. */
export async function hasBaseLaunchActivationRecord(store: Pick<BaseAuditStore, "getBuybackBatch">, manifest: BaseCollectorManifest,
  graphFingerprint: Hex): Promise<boolean> {
  try {
    if (manifest.activation.status !== "canary_verified" || !manifest.activation.nativeExecution || !manifest.canaryAuthorization ||
      !manifest.activation.walletAcceptance || !manifest.activation.pauseRollbackAcceptance || !manifest.activation.nativeRunAcceptance) return false;
    const identity = activationRecordIdentity(manifest, graphFingerprint);
    parseRecord(await store.getBuybackBatch(identity.id), identity);
    return true;
  } catch { return false; }
}
