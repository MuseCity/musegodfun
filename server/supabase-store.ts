import type { Hex } from "viem";
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
    ]);
  }
  close() {}
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
        payload: plan,
      },
      "resolution=merge-duplicates,return=minimal",
    );
  }
  findPlan(creator: string, data: string) {
    return this.request<LaunchPlan | null>("rpc/musegod_find_plan", "POST", {
      p_scope: this.scope,
      p_creator: creator.toLowerCase(),
      p_data: data,
    });
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
  async pendingLaunches() {
    const rows = await this.request<
      {
        hash: Hex;
        plan_id: string;
        status: string;
        block_hash: string | null;
      }[]
    >(
      `musegod_pending_launches?${this.where()}&status=not.in.(failed,replaced)&order=updated_at&limit=100`,
    );
    return rows.map((r) => ({
      hash: r.hash,
      planId: r.plan_id,
      status: r.status,
      blockHash: r.block_hash,
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
