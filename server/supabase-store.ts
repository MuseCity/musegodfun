import type { Hex } from "viem";
import { packPlan, unpackPlan } from "./plan-storage";
import { defaultRuntimeControl, type RuntimeControl, type BudgetName, type BudgetResult } from "./runtime-policy";
import type { TokenRecord } from "../src/lib/config";
import { assertBuybackBatchId, assertBuybackAuditRecord, assertLaunchClaim, postgresTokenConflict, provenanceUpgrade, type LaunchClaimOptions, type Store, type LaunchPlan, type BuybackBatchRecord, type BuybackBatchPageRecord } from "./store";
function assertSequence(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error("Invalid history sequence");
}
export type StoreBackend = {
  [K in Exclude<keyof Store, "db">]: Store[K] extends (...a: infer A) => infer R
    ? (...a: A) => R | Promise<R>
    : never;
};
export class SupabaseStore implements StoreBackend {
  constructor(
    private readonly url: string,
    private readonly key: string,
    readonly scope = "base",
    private readonly quotaScope = scope,
  ) {
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) || !key)
      throw new Error("Invalid Supabase server configuration");
    if (!/^(base|robinhood|verify-[a-z0-9-]+|restore-[a-z0-9-]+)$/.test(scope))
      throw new Error("Invalid database scope");
  }
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    prefer = "return=minimal",
  ): Promise<T> {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      redirect: "manual",
      headers: {
        apikey: this.key,
        ...(this.key.startsWith("eyJ")
          ? { Authorization: `Bearer ${this.key}` }
          : {}),
        "Content-Type": "application/json",
        Prefer: prefer,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      // PostgREST answers a unique violation with 409 and Postgres code 23505. Only the NFT-mode guard indexes, named in the message, are
      // a domain outcome (TokenUniqueConflict); every other failure, including the (scope,address) and (scope,tx_hash) keys, stays generic.
      const conflict = response.status === 409 ? postgresTokenConflict(await response.text().catch(() => "")) : null;
      if (conflict) throw conflict;
      throw new Error(
        `Database request failed (${response.status}). Check the server configuration and migrations.`,
      );
    }
    const raw = await response.text();
    return (raw ? JSON.parse(raw) : undefined) as T;
  }
  private where(extra = "") {
    return `scope=eq.${this.scope}${extra ? "&" + extra : ""}`;
  }
  async health() {
    await Promise.all([
      this.request(`musegod_quota?${this.where()}&select=key&limit=1`),
      this.request(`musegod_buyback_batches?${this.where()}&select=id&limit=1`),
      this.request(`musegod_runtime_controls?${this.where()}&select=revision&limit=1`),
    ]);
  }
  close() {}
  async runtimeControl(): Promise<RuntimeControl> {
    const rows = await this.request<{paused:boolean;revision:number;updated_at:number;reason:string}[]>(`musegod_runtime_controls?${this.where()}&limit=1`);
    return rows[0] ? { paused: rows[0].paused, revision: rows[0].revision, updatedAt: rows[0].updated_at, reason: rows[0].reason } : defaultRuntimeControl();
  }
  updateRuntimeControl(paused: boolean, reason: string, expectedRevision: number): Promise<RuntimeControl> {
    return this.request("rpc/musegod_update_runtime_control", "POST", {p_scope:this.scope,p_paused:paused,p_reason:reason,p_revision:expectedRevision});
  }
  reserveBudget(name: BudgetName, now = Date.now(), recovery = false): Promise<BudgetResult> {
    return this.request("rpc/musegod_reserve_runtime_budget", "POST", {p_name:name,p_now:now,p_recovery:recovery});
  }
  async blockBudget(name: BudgetName, until: number) {
    await this.request("rpc/musegod_block_runtime_budget", "POST", {p_name:name,p_until:until});
  }
  reservePrepareSlot(owner: string, now = Date.now()): Promise<boolean> {
    return this.request("rpc/musegod_reserve_prepare_slot","POST",{p_owner:owner,p_now:now});
  }
  async releasePrepareSlot(owner: string) {
    await this.request(`musegod_prepare_slots?owner=eq.${encodeURIComponent(owner)}`,"DELETE");
  }
  /** Store.claimLaunch, in one call of `musegod_claim_launch` (migration 20261014120000), which serializes claims per scope. */
  async claimLaunch(owner: string, claims: string[], expiresAt: number, { lineage = [], submitted = false, now = Date.now() }: LaunchClaimOptions = {}): Promise<string[]> {
    assertLaunchClaim(owner, claims, expiresAt, now, lineage);
    const held = await this.request<unknown>("rpc/musegod_claim_launch", "POST",
      { p_scope: this.scope, p_owner: owner, p_claims: claims, p_lineage: lineage, p_submitted: submitted, p_expires_at: expiresAt, p_now: now });
    if (!Array.isArray(held) || held.some((claim) => typeof claim !== "string" || !claims.includes(claim))) throw new Error("Launch claim returned an invalid result");
    return held;
  }
  async releaseLaunchClaims(owner: string, { unsubmittedOnly = false }: { unsubmittedOnly?: boolean } = {}) {
    await this.request(`musegod_launch_claims?${this.where(`owner=eq.${encodeURIComponent(owner)}${unsubmittedOnly ? "&submitted=eq.false" : ""}`)}`, "DELETE");
  }
  /** UPDATE only, matching Store.renewLaunchClaims; each PATCH retains the scope, owner and key filters if ownership changes concurrently. */
  async renewLaunchClaims(owner: string, claims: string[], expiresAt: number, now = Date.now()) {
    assertLaunchClaim(owner, claims, expiresAt, now, []);
    const path = `musegod_launch_claims?${this.where(`owner=eq.${encodeURIComponent(owner)}&claim=in.${encodeURIComponent(`(${claims.map((claim) => JSON.stringify(claim)).join(",")})`)}`)}`;
    await this.request(`${path}&submitted=eq.false`, "PATCH", { submitted: true });
    await this.request(`${path}&expires_at=lt.${expiresAt}`, "PATCH", { expires_at: expiresAt, submitted: true });
  }
  async pendingLaunchCount(): Promise<number> {
    const rows=await this.request<{hash:string}[]>(`musegod_pending_launches?${this.where()}&status=eq.pending&select=hash&limit=100`);
    return rows.length;
  }
  async getPlan(id: string): Promise<LaunchPlan|null> {
    const rows = await this.request<{payload:unknown}[]>(`musegod_plans?${this.where()}&id=eq.${encodeURIComponent(id)}&select=payload&limit=1`);
    return rows[0] ? unpackPlan(rows[0].payload) : null;
  }
  async protectPlan(id: string) {
    await this.request(`musegod_plans?${this.where()}&id=eq.${encodeURIComponent(id)}`, "PATCH", {protected_at:Date.now()});
  }
  async tokenByTxHash(hash: string): Promise<TokenRecord|null> {
    const rows = await this.request<{payload:TokenRecord}[]>(`musegod_tokens?${this.where()}&tx_hash=eq.${encodeURIComponent(hash.toLowerCase())}&select=payload&limit=1`);
    return rows[0]?.payload ?? null;
  }
  async tokenPage(limit = 50, before?: {createdAt:number;address:string}): Promise<TokenRecord[]> {
    if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error("Invalid page size");
    if (before && (!Number.isSafeInteger(before.createdAt) || !/^0x[0-9a-f]{40}$/i.test(before.address))) throw new Error("Invalid page cursor");
    const cursor = before ? `&or=(created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},address.gt.${before.address.toLowerCase()}))` : "";
    const rows = await this.request<{payload:TokenRecord}[]>(`musegod_tokens?${this.where()}${cursor}&order=created_at.desc,address&select=payload&limit=${limit}`);
    return rows.map(row=>row.payload);
  }
  async deferLaunch(hash: string, retryAt: number) {
    await this.request("rpc/musegod_defer_launch", "POST", {p_scope:this.scope,p_hash:hash.toLowerCase(),p_retry_at:retryAt});
  }
  async finalizeLaunch(hash: string) {
    await this.request(`musegod_pending_launches?${this.where()}&hash=eq.${encodeURIComponent(hash.toLowerCase())}&status=eq.confirmed`, "PATCH", {finalized:true});
  }
  async saveBuybackBatch(batch: BuybackBatchRecord) {
    assertBuybackBatchId(batch.id);
    const now = Date.now();
    const updatedAt = typeof batch.updatedAt === "number" && Number.isSafeInteger(batch.updatedAt) && batch.updatedAt >= 0 && batch.updatedAt <= now ? batch.updatedAt : now;
    await this.request(
      "musegod_buyback_batches?on_conflict=scope,id", "POST",
      { scope: this.scope, id: batch.id, updated_at: updatedAt, payload: batch },
      "resolution=merge-duplicates,return=minimal",
    );
  }
  async getBuybackBatch(id: string): Promise<BuybackBatchRecord | null> {
    assertBuybackBatchId(id);
    const rows = await this.request<{ payload: BuybackBatchRecord }[]>(
      `musegod_buyback_batches?${this.where()}&id=eq.${encodeURIComponent(id)}&select=payload&limit=1`,
    );
    return rows[0]?.payload ?? null;
  }
  async compareAndSetBuybackAudit(next:BuybackBatchRecord,expected:BuybackBatchRecord|null):Promise<boolean> {
    assertBuybackAuditRecord(next);if(expected!==null){assertBuybackAuditRecord(expected);if(expected.id!==next.id)throw new Error("Internal audit CAS identity differs");}
    const result=await this.request<unknown>("rpc/musegod_compare_and_set_buyback_audit","POST",{p_scope:this.scope,p_next:next,p_expected:expected});
    if(typeof result!=="boolean")throw new Error("Internal audit CAS returned an invalid result");return result;
  }
  async listBuybackBatches(): Promise<BuybackBatchRecord[]> {
    const rows = await this.request<{ payload: BuybackBatchRecord }[]>(
      `musegod_buyback_batches?${this.where()}&order=updated_at.desc,id&select=payload&limit=1000`,
    );
    return rows.map((row) => row.payload);
  }
  async buybackBatchPage(limit = 100, before?: { sequence: string }): Promise<BuybackBatchPageRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid buyback batch page size");
    if(before)assertSequence(before.sequence);
    const cursor = before ? `&sequence=lt.${before.sequence}` : "";
    const rows = await this.request<{ payload: BuybackBatchRecord; updated_at: number; sequence:string }[]>(
      `musegod_buyback_batches?${this.where()}${cursor}&order=sequence.desc&select=payload,updated_at,sequence::text&limit=${limit}`);
    return rows.map(row => ({ ...row.payload, updatedAt: row.updated_at, sequence:row.sequence }));
  }
  async snapshot(key: string): Promise<{ at: number; data: unknown } | null> {
    const rows = await this.request<{ at: number; payload: unknown }[]>(
      `musegod_snapshots?${this.where()}&key=eq.${encodeURIComponent(key)}&select=at,payload`,
    );
    return rows[0] ? { at: rows[0].at, data: rows[0].payload } : null;
  }
  async saveSnapshot(key: string, data: unknown, at: number) {
    await this.request(
      "musegod_snapshots?on_conflict=scope,key",
      "POST",
      { scope: this.scope, key, at, payload: data },
      "resolution=merge-duplicates,return=minimal",
    );
  }
  /** Store.saveProfileSnapshot over PostgREST: insert when absent, otherwise update only a row signed earlier. Each step is one atomic
   * statement and a profile row is never deleted (cleanup keeps `profile:` keys), so an older signature can never replace a newer one. */
  async saveProfileSnapshot(key: string, data: unknown, issuedAt: number): Promise<boolean> {
    const inserted = await this.request<unknown[]>("musegod_snapshots?on_conflict=scope,key&select=key", "POST",
      { scope: this.scope, key, at: issuedAt, payload: data }, "resolution=ignore-duplicates,return=representation");
    if (inserted.length) return true;
    const updated = await this.request<unknown[]>(`musegod_snapshots?${this.where()}&key=eq.${encodeURIComponent(key)}&at=lt.${issuedAt}&select=key`,
      "PATCH", { at: issuedAt, payload: data }, "return=representation");
    return updated.length > 0;
  }
  reserveMarketCall(now: number, daily = 300, monthly = 9000, bucket?: "candles") {
    return this.request<boolean>("rpc/musegod_reserve_market_call", "POST", {
      p_scope: bucket ? `${this.quotaScope}:${bucket}` : this.quotaScope,
      p_now: now,
      p_daily: daily,
      p_monthly: monthly,
    });
  }
  async cleanup(now = Date.now()) {
    await this.request("rpc/musegod_cleanup", "POST", {
      p_scope: this.scope,
      p_now: now,
    });
  }
  async savePlan(plan: LaunchPlan) {
    await this.request(
      "musegod_plans?on_conflict=scope,id",
      "POST",
      {
        scope: this.scope,
        id: plan.id,
        creator: plan.creator.toLowerCase(),
        data: plan.data,
        prepared_at: plan.preparedAt,
        payload: packPlan(plan),
      },
      "resolution=merge-duplicates,return=minimal",
    );
  }
  async savePlanIfAbsent(plan: LaunchPlan) {
    await this.request(
      "musegod_plans?on_conflict=scope,id",
      "POST",
      { scope: this.scope, id: plan.id, creator: plan.creator.toLowerCase(), data: plan.data, prepared_at: plan.preparedAt, payload: packPlan(plan) },
      "resolution=ignore-duplicates,return=minimal",
    );
  }
  async findPlan(creator: string, data: string) {
    const payload = await this.request<LaunchPlan | null>("rpc/musegod_find_plan", "POST", {
      p_scope: this.scope,
      p_creator: creator.toLowerCase(),
      p_data: data,
    });
    return payload ? unpackPlan(payload) : null;
  }
  async saveToken(token: TokenRecord) {
    await this.request(
      "musegod_tokens?on_conflict=scope,address",
      "POST",
      {
        scope: this.scope,
        address: token.address.toLowerCase(),
        tx_hash: token.transactionHash,
        created_at: token.createdAt,
        payload: token,
      },
      "resolution=ignore-duplicates,return=minimal",
    );
  }
  /** Store.upgradeTokenProvenance as a compare-and-swap: the row is read, `provenanceUpgrade` decides what to write, and the write matches the
   * NFT fields that were read (status, spent fee, fee claim). A write that matches nothing (another process settled the row meanwhile) is
   * retried from a fresh read, at most three times; then registration fails retryably rather than writing over the row. */
  async upgradeTokenProvenance(token: TokenRecord) {
    if (token.openingValuationUnverified || !token.transactionHash) return;
    const row = `musegod_tokens?${this.where()}&address=eq.${encodeURIComponent(token.address.toLowerCase())}` +
      `&tx_hash=eq.${encodeURIComponent(token.transactionHash.toLowerCase())}&payload->>openingValuationUnverified=eq.true`;
    const matches = (value: string | undefined, path: string, field: string) =>
      value === undefined ? `&${path}=is.null` : `&${path}->>${field}=eq.${encodeURIComponent(value)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const [read] = await this.request<{ payload: TokenRecord }[]>(`${row}&select=payload&limit=1`);
      if (!read) return;
      const stored = read.payload;
      const written = await this.request<unknown[]>(`${row}${matches(stored.nftVerification?.status, "payload->nftVerification", "status")}` +
        `${matches(stored.launchFee?.txHash, "payload->launchFee", "txHash")}${matches(stored.nftVerification?.feeClaim?.txHash, "payload->nftVerification->feeClaim", "txHash")}` +
        "&select=address", "PATCH", { payload: provenanceUpgrade(token, stored) }, "return=representation");
      if (Array.isArray(written) && written.length) return;
    }
    throw new Error("The token record changed while its provenance was upgraded. Registration will retry.");
  }
  /** The compare-and-swap of Store.updateNftVerification, including the provenance match. PostgREST `not.in` skips NULLs, so an unverified
   * and an absent status are matched by two explicit requests; the first one's write no longer matches the second's filter. The guard
   * indexes of migration 20261014120000 refuse a second `verified` coin for the NFT or a second spend of the fee atomically, in the
   * database, whichever process writes first: the refusal is a TokenUniqueConflict. */
  async updateNftVerification(token: TokenRecord) {
    if (!token.nft || !token.transactionHash || !token.nftVerification) return;
    const row = `musegod_tokens?${this.where()}&address=eq.${encodeURIComponent(token.address.toLowerCase())}` +
      `&tx_hash=eq.${encodeURIComponent(token.transactionHash.toLowerCase())}&payload->nft=not.is.null` +
      `&payload->>openingValuationUnverified=${token.openingValuationUnverified ? "eq.true" : "is.null"}`;
    await this.request(`${row}&payload->nftVerification->>status=eq.unverified`, "PATCH", { payload: token }, "return=minimal");
    await this.request(`${row}&payload->nftVerification=is.null`, "PATCH", { payload: token }, "return=minimal");
  }
  /** Both guard indexes of migration 20261014120000 exist, unique and valid, with its launch-claim table, submitted column and function
   * (`musegod_nft_guards_ready`).
   * Any failure, including a project without the migration (404), counts as not ready, so NFT mode fails closed. */
  async nftGuardsReady(): Promise<boolean> {
    return this.request<unknown>("rpc/musegod_nft_guards_ready", "POST", {}).then((ready) => ready === true, () => false);
  }
  async tokens(): Promise<TokenRecord[]> {
    const result: TokenRecord[] = [];
    for (let offset = 0; ; offset += 1000) {
      const rows = await this.request<{ payload: TokenRecord }[]>(
        `musegod_tokens?${this.where()}&order=created_at.desc,address&select=payload&offset=${offset}&limit=1000`,
      );
      result.push(...rows.map((r) => r.payload));
      if (rows.length < 1000) return result;
    }
  }
  async verifiedNftCoin(key: string, excludeAddress?: string): Promise<TokenRecord | null> {
    const [chainId, contract, tokenId] = key.split(":");
    const rows = await this.request<{ payload: TokenRecord }[]>(`musegod_tokens?${this.where()}&payload->nft->>chainId=eq.${encodeURIComponent(chainId)}` +
      `&payload->nft->>contract=ilike.${encodeURIComponent(contract)}&payload->nft->>tokenId=eq.${encodeURIComponent(tokenId)}` +
      `&payload->nftVerification->>status=eq.verified${excludeAddress ? `&address=neq.${encodeURIComponent(excludeAddress.toLowerCase())}` : ""}` +
      `&order=created_at.asc&select=payload&limit=1`);
    return rows[0]?.payload ?? null;
  }
  async tokenUsingLaunchFee(txHash: string, creator: string, excludeAddress?: string): Promise<TokenRecord | null> {
    const rows = await this.request<{ payload: TokenRecord }[]>(`musegod_tokens?${this.where()}&payload->launchFee->>txHash=ilike.${encodeURIComponent(txHash.toLowerCase())}` +
      `&payload->>creator=ilike.${encodeURIComponent(creator.toLowerCase())}` +
      `${excludeAddress ? `&address=neq.${encodeURIComponent(excludeAddress.toLowerCase())}` : ""}&select=payload&limit=1`);
    return rows[0]?.payload ?? null;
  }
  async token(address: string) {
    const rows = await this.request<{ payload: TokenRecord }[]>(
      `musegod_tokens?${this.where()}&address=eq.${address.toLowerCase()}&select=payload`,
    );
    return rows[0]?.payload ?? null;
  }
  async trackLaunch(hash: string, planId: string) {
    await this.request(
      "musegod_pending_launches?on_conflict=scope,hash",
      "POST",
      {
        scope: this.scope,
        hash: hash.toLowerCase(),
        plan_id: planId,
        status: "pending",
        updated_at: Date.now(),
      },
      "resolution=ignore-duplicates,return=minimal",
    );
  }
  async pendingLaunches(now = Date.now()) {
    const rows = await this.request<
      {
        hash: Hex;
        plan_id: string;
        status: string;
        block_hash: string | null;
        retry_at: number; attempts: number; finalized: boolean;
      }[]
    >(
      `musegod_pending_launches?${this.where()}&status=not.in.(failed,replaced)&finalized=eq.false&retry_at=lte.${now}&order=retry_at,updated_at&limit=100`,
    );
    return rows.map((r) => ({
      hash: r.hash,
      planId: r.plan_id,
      status: r.status,
      blockHash: r.block_hash,
      retryAt: r.retry_at, attempts: r.attempts, finalized: r.finalized,
    }));
  }
  async launchStatus(
    hash: string,
    status: string,
    blockHash: string | null = null,
  ) {
    await this.request("rpc/musegod_mark_launch", "POST", {
      p_scope: this.scope,
      p_hash: hash.toLowerCase(),
      p_status: status,
      p_block_hash: blockHash,
    });
  }
  async removeToken(hash: string) {
    await this.request(
      `musegod_tokens?${this.where()}&tx_hash=eq.${hash.toLowerCase()}`,
      "DELETE",
    );
  }
  backup() {
    return this.request<Record<string, unknown>>("rpc/musegod_backup", "POST", {
      p_scope: this.scope,
    });
  }
  async restore(backup: unknown) {
    await this.request("rpc/musegod_restore", "POST", {
      p_scope: this.scope,
      p_backup: backup,
    });
  }
}
