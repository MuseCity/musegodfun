import { isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { deploymentChain, sameAddress } from "../src/lib/config";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_TREASURY, BASE_BUYBACK_VAULT, BASE_NATIVE_DESTINATION_POLICY, type BaseCollectorStatus } from "../src/lib/base-buyback";
import { custodyMaxLag, emptyCustodyReport } from "../src/lib/buyback-custody-ledger";
import { emptyVaultLedgerReport, type VaultLedgerReport } from "../src/lib/buyback-vault-ledger";
import { BASE_COLLECTOR_MANIFEST, baseCollectorGraphFingerprint } from "./base-collector";
import rhDeployment from "../contracts/artifacts/buyback-v2-deployment.json";
import type { NativeCustodyReadiness, VaultLedgerRuntime } from "./buyback-vault-runtime";
import type { Runtime } from "./config";
import type { StoreBackend } from "./supabase-store";

export const BASE_AUDIT_SNAPSHOT_TTL_MS = 60_000;
export type BaseAuditSourceStatus = Awaited<ReturnType<VaultLedgerRuntime["sourceStatus"]>>;
export type BaseAuditSnapshotContents = {
  /** Start of the observed round. Publication freshness is display-only. */
  observedAt: number;
  graph: { collector: Address; automationReceiver: Address; paused: boolean; activationVerified: boolean } | null;
  collectorStatus: BaseCollectorStatus;
  custody: NativeCustodyReadiness;
  vaultLedger: VaultLedgerReport;
  sourceStatus: BaseAuditSourceStatus;
  anchors: [{ chainId: 8453; number: string; hash: Hex }, { chainId: 4663; number: string; hash: Hex }];
  revisions: { automation: number; treasury: number; vault: number };
};
export type BaseAuditSnapshot = BaseAuditSnapshotContents & {
  id: string; protocol: "internal_native_host_snapshot_v1"; version: 1;
  scope: string; runtimeChainId: 8453 | 4663; binding: Hex; generation: number; publishedAt: number; expiresAt: number;
  /** Start of the failed audit round; retained amounts still belong to observedAt. */
  failedAt?: number;
};
type SnapshotStore = Pick<StoreBackend, "getBuybackBatch">;
type SnapshotWriter = SnapshotStore & Pick<StoreBackend, "compareAndSetBuybackAudit">;
const protocol = "internal_native_host_snapshot_v1" as const;
const raw = z.string().regex(/^(0|[1-9]\d{0,77})$/);
const hash = z.string().regex(/^0x[\da-f]{64}$/i);
const address = z.string().refine(value => isAddress(value, { strict: false }));
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nullableRaw = raw.nullable();
const custodySchema = z.object({
  id: z.enum(["base_automation", "robinhood_treasury"]), ready: z.boolean(), caughtUp: z.boolean(), fresh: z.boolean(),
  lagBlocks: raw, maxLagBlocks: raw, reason: z.string().nullable(), revision,
  checkpointBlock: nullableRaw, indexedThrough: nullableRaw, confirmedThrough: raw,
  consumptions: z.array(z.object({ eventId: z.string(), asset: address, amount: raw,
    fragments: z.array(z.object({ batchId: z.string().nullable(), amount: raw })) })),
  withheldEventIds: z.array(z.string()),
  assets: z.array(z.object({ asset: address, ready: z.boolean(), reason: z.string().nullable(),
    received: raw, pending: raw, baseReceived: raw, basePending: raw })),
});
const source = z.enum(["base", "robinhood_engine", "donation", "unknown"]);
const vaultSchema = z.object({
  version: z.literal(1), initialized: z.boolean(), caughtUp: z.boolean(), fresh: z.boolean(), attributionReady: z.boolean(),
  lagBlocks: raw, maxLagBlocks: raw, reason: z.string().nullable(), checkpointBlock: nullableRaw, indexedThrough: nullableRaw, confirmedThrough: raw,
  baseReceivedWeth: raw, baseSpentWeth: raw, basePendingWeth: raw, baseAttributedMuseToDead: raw,
  totalExecutionWeth: raw, totalMuseToDead: raw, totalCallerProfit: raw,
  lots: z.array(z.object({ id: z.string(), source, batchId: z.string().nullable(), received: raw, consumed: raw, remaining: raw, museToDead: raw })),
  allocations: z.array(z.object({ executionId: z.string(), lotId: z.string(), source, batchId: z.string().nullable(), wethAmount: raw, museToDead: raw })),
  batches: z.array(z.object({ batchId: z.string(), receivedWeth: raw, spentWeth: raw, pendingWeth: raw, attributedMuseToDead: raw,
    status: z.enum(["pending_vault", "partially_consumed", "consumed"]) })),
});
const collectorSchema = z.object({
  kind: z.literal("base_splits_native"), protocol: z.literal(BASE_BUYBACK_PROTOCOL), chainId: z.literal(8453), available: z.boolean(),
  collector: address.nullable(), automation: address.nullable(), destinationChainId: z.literal(4663),
  destinationTreasury: address, destinationVault: address, paused: z.boolean(),
  nativeAutomationState: z.enum(["unverified", "configured", "paused"]), totalBridgedWeth: raw, totalRefundedWeth: raw,
  assets: z.array(z.object({ chainId: z.literal(8453), address, symbol: z.string().max(64), decimals: z.number().int().min(0).max(255),
    pending: raw, untracked: raw, totalClaimed: raw, totalReleased: raw, automationBalance: raw,
    pendingUntracked: raw.optional(), totalUntrackedSynced: raw.optional(), totalUntrackedReleased: raw.optional(), verifiedAsset: z.boolean().optional() })),
  // These private rows are sanitized by the existing public batch projection.
  batches: z.array(z.object({ id: z.string().min(1).max(200), protocol: z.literal(BASE_BUYBACK_PROTOCOL), sourceChainId: z.literal(8453),
    destinationChainId: z.literal(4663), collector: address, kind: z.string().min(1), status: z.string().min(1), createdAt: revision, updatedAt: revision,
    amountIn: raw, receivedAmount: raw, refundedAmount: raw, burnedAmount: raw, claimHashes: z.array(hash) }).passthrough()),
  ledgerComplete: z.boolean(), assetsComplete: z.boolean(), error: z.string().optional(),
});
const schema = z.object({
  id: z.string(), protocol: z.literal(protocol), version: z.literal(1), scope: z.string(), runtimeChainId: z.union([z.literal(8453), z.literal(4663)]),
  binding: hash, generation: revision, observedAt: revision, publishedAt: revision, expiresAt: revision, failedAt: revision.optional(),
  graph: z.object({ collector: address, automationReceiver: address, paused: z.boolean(), activationVerified: z.boolean() }).nullable(),
  collectorStatus: collectorSchema,
  custody: z.object({ ready: z.boolean(), reason: z.string().nullable(), automation: custodySchema, treasury: custodySchema, vault: vaultSchema }),
  vaultLedger: vaultSchema,
  sourceStatus: z.object({ ready: z.boolean(), assets: z.array(z.object({ asset: address, pending: raw, verifiedClaimed: raw })), receivedWeth: raw, refundedWeth: raw }),
  anchors: z.tuple([z.object({ chainId: z.literal(8453), number: raw, hash }), z.object({ chainId: z.literal(4663), number: raw, hash })]),
  revisions: z.object({ automation: revision, treasury: revision, vault: revision }),
});
/** The full reviewed artifact includes activation and private-canary authority;
 * a graph revision or namespace change selects a different private row. */
function identity(runtime: Runtime) {
  if (runtime.config.mode === "fork") throw new Error("Forks cannot consume canonical host audit snapshots");
  const runtimeChainId = deploymentChain(runtime.config);
  if (!/^(base|robinhood|verify-[a-z0-9-]+|restore-[a-z0-9-]+)$/.test(runtime.dataScope) ||
    runtime.dataScope === "base" && runtimeChainId !== 8453 || runtime.dataScope === "robinhood" && runtimeChainId !== 4663)
    throw new Error("Host audit snapshot scope and chain differ");
  const collector = runtimeChainId === 8453 ? runtime.config.feeEngine
    : runtime.environment?.BASE_FEE_COLLECTOR_ADDRESS ?? BASE_COLLECTOR_MANIFEST.collector.address;
  const binding = keccak256(stringToHex(JSON.stringify([protocol, runtime.dataScope, runtimeChainId, runtime.canaryOrigin ?? null,
    collector?.toLowerCase() ?? null, BASE_NATIVE_DESTINATION_POLICY, BASE_COLLECTOR_MANIFEST, rhDeployment])));
  return { id: `internal_native_host_snapshot:${binding}`, binding, runtimeChainId, scope: runtime.dataScope, collector };
}
function parseSnapshot(runtime: Runtime, value: unknown, now: number): BaseAuditSnapshot | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const row = parsed.data as unknown as BaseAuditSnapshot, expected = identity(runtime), { graph, custody, collectorStatus: status } = row;
  // Host/Worker clock skew can withhold display. Never rewrite host timestamps
  // or extend the display TTL to compensate; issuance/signing use other gates.
  if (row.id !== expected.id || row.binding !== expected.binding || row.scope !== expected.scope || row.runtimeChainId !== expected.runtimeChainId ||
    row.generation < 1 || row.observedAt > row.publishedAt || row.publishedAt > now || row.expiresAt <= now || row.expiresAt <= row.publishedAt || row.expiresAt - row.publishedAt > BASE_AUDIT_SNAPSHOT_TTL_MS ||
    !sameAddress(status.destinationTreasury, BASE_BUYBACK_TREASURY) || !sameAddress(status.destinationVault, BASE_BUYBACK_VAULT) ||
    custody.automation.id !== "base_automation" || custody.treasury.id !== "robinhood_treasury" ||
    custody.automation.maxLagBlocks !== String(custodyMaxLag("base_automation")) || custody.treasury.maxLagBlocks !== String(custodyMaxLag("robinhood_treasury")) ||
    row.vaultLedger.maxLagBlocks !== emptyVaultLedgerReport(0n).maxLagBlocks ||
    row.revisions.automation !== custody.automation.revision || row.revisions.treasury !== custody.treasury.revision ||
    JSON.stringify(row.vaultLedger) !== JSON.stringify(custody.vault)) return null;
  if (row.failedAt !== undefined && (row.failedAt < row.observedAt || row.failedAt > row.publishedAt || graph !== null || status.available ||
    custody.ready || custody.automation.ready || custody.automation.fresh || custody.treasury.ready || custody.treasury.fresh ||
    row.vaultLedger.attributionReady || row.vaultLedger.fresh || row.sourceStatus.ready)) return null;
  for (const [report, anchor] of [[custody.automation, row.anchors[0]], [custody.treasury, row.anchors[1]], [row.vaultLedger, row.anchors[1]]] as const) {
    if (BigInt(report.confirmedThrough) > BigInt(anchor.number) || report.indexedThrough !== null && BigInt(report.indexedThrough) > BigInt(report.confirmedThrough) ||
      report.checkpointBlock !== null && (report.indexedThrough === null || BigInt(report.checkpointBlock) > BigInt(report.indexedThrough)) ||
      report.indexedThrough !== null && BigInt(report.lagBlocks) !== BigInt(report.confirmedThrough) - BigInt(report.indexedThrough) ||
      report.fresh && (report.indexedThrough === null || BigInt(report.lagBlocks) > BigInt(report.maxLagBlocks))) return null;
  }
  if (custody.ready && (!custody.automation.ready || !custody.automation.fresh || !custody.treasury.ready || !custody.treasury.fresh || !row.vaultLedger.attributionReady || !row.vaultLedger.fresh) ||
    custody.automation.ready && (custody.automation.checkpointBlock === null || custody.automation.revision < 1) ||
    custody.treasury.ready && (custody.treasury.checkpointBlock === null || custody.treasury.revision < 1) ||
    row.vaultLedger.attributionReady && (!row.vaultLedger.initialized || row.vaultLedger.checkpointBlock === null || row.revisions.vault < 1) || status.ledgerComplete && !row.sourceStatus.ready ||
    row.sourceStatus.ready && (!custody.automation.ready || !custody.automation.fresh || !custody.treasury.ready || !custody.treasury.fresh ||
      custody.automation.assets.some(asset => !asset.ready) || custody.treasury.assets.some(asset => !asset.ready) || custody.automation.withheldEventIds.length || custody.treasury.withheldEventIds.length)) return null;
  if (graph) {
    // An address and a status flag cannot complete an undeployed or malformed
    // reviewed artifact. This is a local structural check, never an RPC audit.
    baseCollectorGraphFingerprint(BASE_COLLECTOR_MANIFEST);
    if (!expected.collector || !BASE_COLLECTOR_MANIFEST.collector.address || !BASE_COLLECTOR_MANIFEST.constants.automationReceiver ||
      !sameAddress(graph.collector, expected.collector) || !sameAddress(graph.collector, BASE_COLLECTOR_MANIFEST.collector.address) ||
      !sameAddress(graph.automationReceiver, BASE_COLLECTOR_MANIFEST.constants.automationReceiver) ||
      status.batches.some(batch => !sameAddress(batch.collector, graph.collector)) ||
      status.available && (!status.collector || !status.automation || !sameAddress(status.collector, graph.collector) || !sameAddress(status.automation, graph.automationReceiver) || status.paused !== graph.paused) ||
      graph.activationVerified && !applicableActivation(runtime, now)) return null;
  } else if (status.available || custody.ready || row.sourceStatus.ready || status.ledgerComplete || status.nativeAutomationState !== "unverified") return null;
  return row;
}
function applicableActivation(runtime: Runtime, now: number) {
  if (!runtime.canaryOrigin && runtime.dataScope !== "verify-base-canary") return BASE_COLLECTOR_MANIFEST.activation.status === "canary_verified";
  const authorization = BASE_COLLECTOR_MANIFEST.canaryAuthorization;
  if (!/^verify-[a-z0-9-]+$/.test(runtime.dataScope) || runtime.environment?.NODE_ENV === "production" || !runtime.canaryOrigin ||
    !authorization || authorization.version !== 2 || authorization.chainId !== 8453 || authorization.origin !== runtime.canaryOrigin ||
    !/^[1-9]\d{0,77}$/.test(authorization.expiresAt) || BigInt(authorization.expiresAt) * 1000n <= BigInt(now) ||
    authorization.graphFingerprint !== baseCollectorGraphFingerprint(BASE_COLLECTOR_MANIFEST)) return false;
  const origin = new URL(runtime.canaryOrigin);
  return origin.origin === runtime.canaryOrigin && !origin.username && !origin.password && !["musegod.fun", "www.musegod.fun"].includes(origin.hostname);
}
/** Reads server-private persisted display evidence only. Headers/public bodies
 * cannot cause an audit or manufacture a fresh canonical authorization. */
export async function readBaseAuditSnapshot(runtime: Runtime, store: SnapshotStore): Promise<BaseAuditSnapshot | null> {
  try { const expected = identity(runtime); return parseSnapshot(runtime, await store.getBuybackBatch(expected.id), Date.now()); }
  catch { return null; }
}
/** Called only by the off-Worker host after its own complete canonical audit. */
export async function publishBaseAuditSnapshot(runtime: Runtime, store: SnapshotWriter, contents: BaseAuditSnapshotContents): Promise<BaseAuditSnapshot> {
  const expected = identity(runtime), previous = await store.getBuybackBatch(expected.id), now = Date.now();
  const old = previous as Partial<BaseAuditSnapshot> | null;
  if (old && (old.id !== expected.id || old.protocol !== protocol || old.binding !== expected.binding || !Number.isSafeInteger(old.generation) ||
    !Number.isSafeInteger(old.observedAt) || old.failedAt !== undefined && (!Number.isSafeInteger(old.failedAt) || old.failedAt < old.observedAt!) ||
    contents.observedAt <= (old.failedAt ?? old.observedAt)!)) throw new Error("Host audit snapshot is older than retained progress");
  const { collector: _collector, ...storedIdentity } = expected;
  let expiresAt = now + BASE_AUDIT_SNAPSHOT_TTL_MS;
  const authorization = BASE_COLLECTOR_MANIFEST.canaryAuthorization;
  if (contents.graph?.activationVerified && runtime.canaryOrigin && authorization && /^[1-9]\d{0,77}$/.test(authorization.expiresAt))
    expiresAt = Number(BigInt(authorization.expiresAt) * 1000n < BigInt(expiresAt) ? BigInt(authorization.expiresAt) * 1000n : BigInt(expiresAt));
  const next: BaseAuditSnapshot = { ...structuredClone(contents), ...storedIdentity, protocol, version: 1,
    generation: (old?.generation ?? 0) + 1, publishedAt: now, expiresAt, failedAt: undefined };
  const parsed = parseSnapshot(runtime, next, now);
  if (!parsed) throw new Error("Host audit snapshot is expired, inconsistent or differs from the reviewed graph");
  if (!await store.compareAndSetBuybackAudit(parsed, previous)) throw new Error("Host audit snapshot changed concurrently; retry a new audit");
  return parsed;
}
/** A failed host round may replace its own display projection, never a newer
 * observation. Retain known anchors/history while withholding all readiness. */
export async function publishBaseAuditFailure(runtime: Runtime, store: SnapshotWriter, failedAt: number,
  reason = "Buyback statistics are delayed; fee processing continues in batches."): Promise<BaseAuditSnapshot | null> {
  const expected = identity(runtime), previous = await store.getBuybackBatch(expected.id), now = Date.now();
  const checked = schema.safeParse(previous);
  if (!checked.success) return null;
  const old = checked.data as unknown as BaseAuditSnapshot;
  if (old.id !== expected.id || old.binding !== expected.binding || failedAt < (old.failedAt ?? old.observedAt) || !Number.isSafeInteger(failedAt) || failedAt > now) return null;
  const vault = { ...old.vaultLedger, fresh: false, caughtUp: false, attributionReady: false, reason };
  const unavailableCustody = (value: typeof old.custody.automation) => ({ ...value, ready: false, fresh: false, caughtUp: false, reason,
    assets: value.assets.map(asset => ({ ...asset, ready: false, reason })) });
  const next: BaseAuditSnapshot = { ...old, failedAt, publishedAt: now, expiresAt: now + BASE_AUDIT_SNAPSHOT_TTL_MS, generation: old.generation + 1,
    graph: null, collectorStatus: unavailableBaseCollectorStatus(reason),
    custody: { ready: false, reason, automation: unavailableCustody(old.custody.automation), treasury: unavailableCustody(old.custody.treasury), vault },
    vaultLedger: vault, sourceStatus: { ...old.sourceStatus, ready: false } };
  const parsed = parseSnapshot(runtime, next, now);
  if (!parsed) return null;
  if (!await store.compareAndSetBuybackAudit(parsed, previous)) throw new Error("Host audit failure projection changed concurrently; preserve the newer display");
  return parsed;
}
export function unavailableBaseCollectorStatus(reason = "Buyback statistics are delayed; fee processing continues in batches."): BaseCollectorStatus {
  return { kind: "base_splits_native", protocol: BASE_BUYBACK_PROTOCOL, chainId: 8453, available: false, collector: null, automation: null,
    destinationChainId: 4663, destinationTreasury: BASE_BUYBACK_TREASURY, destinationVault: BASE_BUYBACK_VAULT,
    paused: true, nativeAutomationState: "unverified", totalBridgedWeth: "0", totalRefundedWeth: "0", assets: [], batches: [], assetsComplete: false, ledgerComplete: false, error: reason };
}
export function createPersistedVaultLedgerRuntime({ runtime, store }: { runtime: Runtime; store: SnapshotStore }): VaultLedgerRuntime {
  const unavailable = (): NativeCustodyReadiness => {
    const reason = "Buyback statistics are delayed; fee processing continues in batches.";
    return { ready: false, reason, automation: emptyCustodyReport("base_automation", 0n, reason), treasury: emptyCustodyReport("robinhood_treasury", 0n, reason), vault: emptyVaultLedgerReport(0n, reason) };
  };
  return {
    async read() { const snapshot = await readBaseAuditSnapshot(runtime, store); return snapshot ?
      { ...snapshot.vaultLedger, auditObservedAt: snapshot.observedAt, auditExpiresAt: snapshot.expiresAt,
        ...(snapshot.failedAt === undefined ? {} : { auditFailedAt: snapshot.failedAt }) } : unavailable().vault; },
    async custody() { const snapshot = await readBaseAuditSnapshot(runtime, store); return snapshot ?
      { ...snapshot.custody, auditObservedAt: snapshot.observedAt, auditExpiresAt: snapshot.expiresAt,
        ...(snapshot.failedAt === undefined ? {} : { auditFailedAt: snapshot.failedAt }) } : unavailable(); },
    async sourceStatus() { return (await readBaseAuditSnapshot(runtime, store))?.sourceStatus ?? { ready: false, assets: [], receivedWeth: "0", refundedWeth: "0" }; },
    async automationPolicy() { return (await readBaseAuditSnapshot(runtime, store))?.collectorStatus.nativeAutomationState ?? "unverified"; },
    async initialize() { throw new Error("Public financial audit snapshots are read-only; initialize from the private host"); },
    async reconcile() { throw new Error("Public financial audit snapshots are read-only; reconcile from the private host"); },
    close() {},
  };
}
