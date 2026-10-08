import type { Hex } from "viem";
import { packPlan, unpackPlan } from "./plan-storage";
import { defaultRuntimeControl, type RuntimeControl, type BudgetName, type BudgetResult } from "./runtime-policy";
import type { TokenRecord } from "../src/lib/config";
import { assertBuybackBatchId, type Store, type LaunchPlan, type BuybackBatchRecord } from "./store";
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
    if (!response.ok)
      throw new Error(
        `Database request failed (${response.status}). Check the server configuration and migrations.`,
      );
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
    await this.request(
      "musegod_buyback_batches?on_conflict=scope,id", "POST",
      { scope: this.scope, id: batch.id, updated_at: Date.now(), payload: batch },
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
  async listBuybackBatches(): Promise<BuybackBatchRecord[]> {
    const rows = await this.request<{ payload: BuybackBatchRecord }[]>(
      `musegod_buyback_batches?${this.where()}&order=updated_at.desc,id&select=payload&limit=1000`,
    );
    return rows.map((row) => row.payload);
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
  reserveMarketCall(now: number, daily = 300, monthly = 9000) {
    return this.request<boolean>("rpc/musegod_reserve_market_call", "POST", {
      p_scope: this.quotaScope,
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
  async upgradeTokenProvenance(token: TokenRecord) {
    if (token.openingValuationUnverified || !token.transactionHash) return;
    await this.request(
      `musegod_tokens?${this.where()}&address=eq.${encodeURIComponent(token.address.toLowerCase())}&tx_hash=eq.${encodeURIComponent(token.transactionHash.toLowerCase())}&payload->>openingValuationUnverified=eq.true`,
      "PATCH", { payload: token }, "return=minimal",
    );
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
