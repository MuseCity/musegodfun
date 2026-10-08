import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { packPlan, unpackPlan } from "./plan-storage";
import { BUDGETS, defaultRuntimeControl, type RuntimeControl, type BudgetName, type BudgetResult } from "./runtime-policy";
import type { Address, Hex } from "viem";
import type { TokenRecord } from "../src/lib/config";
import type { LaunchPlan } from "../src/lib/launch-plan";
export type { LaunchPlan } from "../src/lib/launch-plan";
export type BuybackBatchRecord = Record<string, unknown> & { id: string };
export function assertBuybackBatchId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 200)
    throw new Error("Invalid buyback batch ID");
}
export class Store {
  readonly db: DatabaseSync;
  private readonly budgetDb: DatabaseSync;
  constructor(directory: string, chainId: number) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "launchpad.sqlite"));
    this.budgetDb = new DatabaseSync(join(chainId === 31337 ? directory : dirname(directory), "runtime-budgets.sqlite"));
    this.budgetDb.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runtime_budget (name TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(name,bucket)); CREATE TABLE IF NOT EXISTS runtime_circuit (name TEXT PRIMARY KEY,until_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS prepare_slots (owner TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);");
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, creator TEXT NOT NULL, data TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY, tx_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL);",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quota (key TEXT PRIMARY KEY, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_launches (hash TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL, block_hash TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS buyback_batches (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS buyback_batches_updated ON buyback_batches(updated_at DESC,id);
      PRAGMA busy_timeout=5000;`);
    const columns = new Set((this.db.prepare("PRAGMA table_info(pending_launches)").all() as {name:string}[]).map(c => c.name));
    for (const [name, type] of [["retry_at", "INTEGER NOT NULL DEFAULT 0"], ["attempts", "INTEGER NOT NULL DEFAULT 0"], ["finalized", "INTEGER NOT NULL DEFAULT 0"]])
      if (!columns.has(name)) this.db.exec(`ALTER TABLE pending_launches ADD COLUMN ${name} ${type}`);
    this.db.exec("CREATE TABLE IF NOT EXISTS protected_plans (id TEXT PRIMARY KEY,protected_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS runtime_control (id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,reason TEXT NOT NULL); CREATE INDEX IF NOT EXISTS tokens_page ON tokens(created_at DESC,address); CREATE INDEX IF NOT EXISTS pending_active_queue ON pending_launches(retry_at,updated_at) WHERE finalized=0 AND status NOT IN ('failed','replaced');");
    this.db
      .prepare("INSERT OR IGNORE INTO metadata VALUES (?, ?)")
      .run("chainId", String(chainId));
    const stored = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get("chainId") as { value: string };
    if (stored.value !== String(chainId)) {
      this.db.close();
      this.budgetDb.close();
      throw new Error(
        "The database network does not match. Configure separate DATA_DIR values for each network and local fork.",
      );
    }
  }
  health() {
    this.db.prepare("SELECT 1").get();
  }
  close() {
    this.db.close();
    this.budgetDb.close();
  }
  runtimeControl(): RuntimeControl {
    const row = this.db.prepare("SELECT paused,revision,updated_at AS updatedAt,reason FROM runtime_control WHERE id=1").get() as any;
    return row ? { ...row, paused: !!row.paused } : defaultRuntimeControl();
  }
  updateRuntimeControl(paused: boolean, reason: string, expectedRevision: number): RuntimeControl {
    if (!reason.trim() || reason.length > 240 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid runtime control update");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.runtimeControl().revision !== expectedRevision) throw new Error("Runtime control revision changed; read it again");
      this.db.prepare("INSERT INTO runtime_control VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET paused=excluded.paused,revision=excluded.revision,updated_at=excluded.updated_at,reason=excluded.reason")
        .run(paused ? 1 : 0, expectedRevision + 1, Date.now(), reason);
      this.db.exec("COMMIT"); return this.runtimeControl();
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  reserveBudget(name: BudgetName, now = Date.now(), recovery = false): BudgetResult {
    const policy = BUDGETS[name];
    if (!policy || !Number.isSafeInteger(now)) throw new Error("Invalid runtime budget");
    this.budgetDb.exec("BEGIN IMMEDIATE");
    try {
      const circuit = this.budgetDb.prepare("SELECT until_at FROM runtime_circuit WHERE name=?").get(name) as {until_at:number}|undefined;
      if (circuit && circuit.until_at > now) { this.budgetDb.exec("COMMIT"); return {allowed:false,retryAfter:Math.ceil((circuit.until_at-now)/1000)}; }
      this.budgetDb.prepare("DELETE FROM runtime_budget WHERE name=? AND bucket<?").run(name, now - policy.windows.at(-1)![0] - 1000);
      for (const [duration, maximum] of policy.windows) {
        const used = this.budgetDb.prepare("SELECT COALESCE(SUM(count),0) AS n FROM runtime_budget WHERE name=? AND bucket>=?").get(name, Math.floor((now-duration)/1000)*1000) as {n:number};
        if (used.n >= Math.floor(maximum * (recovery ? 1 : 1-policy.reserve))) { this.budgetDb.exec("COMMIT"); return {allowed:false,retryAfter:Math.ceil(duration/1000)}; }
      }
      this.budgetDb.prepare("INSERT INTO runtime_budget VALUES(?,?,1) ON CONFLICT(name,bucket) DO UPDATE SET count=count+1").run(name,Math.floor(now/1000)*1000);
      this.budgetDb.exec("COMMIT"); return {allowed:true,retryAfter:0};
    } catch(error) { this.budgetDb.exec("ROLLBACK"); throw error; }
  }
  blockBudget(name: BudgetName, until: number) {
    this.budgetDb.prepare("INSERT INTO runtime_circuit VALUES(?,?) ON CONFLICT(name) DO UPDATE SET until_at=MAX(until_at,excluded.until_at)").run(name,until);
  }
  reservePrepareSlot(owner: string, now = Date.now()): boolean {
    if(!/^[a-f0-9-]{36}$/.test(owner) || !Number.isSafeInteger(now))throw new Error("Invalid preview lease");
    this.budgetDb.exec("BEGIN IMMEDIATE");
    try {
      this.budgetDb.prepare("DELETE FROM prepare_slots WHERE expires_at<=?").run(now);
      const existing=this.budgetDb.prepare("SELECT owner FROM prepare_slots WHERE owner=?").get(owner);
      const count=this.budgetDb.prepare("SELECT count(*) AS n FROM prepare_slots").get() as {n:number};
      const allowed=!!existing || count.n<4;
      if(allowed)this.budgetDb.prepare("INSERT INTO prepare_slots VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET expires_at=excluded.expires_at").run(owner,now+240_000);
      this.budgetDb.exec("COMMIT");return allowed;
    } catch(error){this.budgetDb.exec("ROLLBACK");throw error;}
  }
  releasePrepareSlot(owner: string) {this.budgetDb.prepare("DELETE FROM prepare_slots WHERE owner=?").run(owner);}
  pendingLaunchCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM pending_launches WHERE status='pending'").get() as {n:number}).n;
  }
  getPlan(id: string): LaunchPlan | null {
    const row = this.db.prepare("SELECT payload FROM plans WHERE id=?").get(id) as {payload:string}|undefined;
    return row ? unpackPlan(JSON.parse(row.payload)) : null;
  }
  protectPlan(id: string) { this.db.prepare("INSERT OR IGNORE INTO protected_plans VALUES(?,?)").run(id,Date.now()); }
  tokenByTxHash(hash: string): TokenRecord | null {
    const row = this.db.prepare("SELECT payload FROM tokens WHERE tx_hash=?").get(hash.toLowerCase()) as {payload:string}|undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  tokenPage(limit = 50, before?: {createdAt:number;address:string}): TokenRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page size");
    const rows = before ? this.db.prepare("SELECT payload FROM tokens WHERE created_at<? OR (created_at=? AND address>?) ORDER BY created_at DESC,address LIMIT ?").all(before.createdAt,before.createdAt,before.address.toLowerCase(),limit)
      : this.db.prepare("SELECT payload FROM tokens ORDER BY created_at DESC,address LIMIT ?").all(limit);
    return (rows as {payload:string}[]).map(row => JSON.parse(row.payload));
  }
  deferLaunch(hash: string, retryAt: number) { this.db.prepare("UPDATE pending_launches SET retry_at=?,attempts=attempts+1 WHERE hash=?").run(retryAt,hash.toLowerCase()); }
  finalizeLaunch(hash: string) { this.db.prepare("UPDATE pending_launches SET finalized=1 WHERE hash=? AND status='confirmed'").run(hash.toLowerCase()); }
  saveBuybackBatch(batch: BuybackBatchRecord) {
    assertBuybackBatchId(batch.id);
    this.db.prepare(
      "INSERT INTO buyback_batches VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload",
    ).run(batch.id, Date.now(), JSON.stringify(batch));
  }
  getBuybackBatch(id: string): BuybackBatchRecord | null {
    assertBuybackBatchId(id);
    const row = this.db.prepare("SELECT payload FROM buyback_batches WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  listBuybackBatches(): BuybackBatchRecord[] {
    return (this.db.prepare(
      "SELECT payload FROM buyback_batches ORDER BY updated_at DESC,id LIMIT 1000",
    ).all() as { payload: string }[]).map((row) => JSON.parse(row.payload));
  }
  snapshot(key: string): { at: number; data: unknown } | null {
    const row = this.db
      .prepare("SELECT payload FROM snapshots WHERE key=?")
      .get(key) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  saveSnapshot(key: string, data: unknown, at: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO snapshots VALUES(?,?,?)")
      .run(key, at, JSON.stringify({ at, data }));
  }
  reserveMarketCall(now: number, daily = 300, monthly = 9000) {
    const day = new Date(now).toISOString().slice(0, 10),
      month = day.slice(0, 7);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = (key: string) =>
        Number(
          (
            this.db.prepare("SELECT count FROM quota WHERE key=?").get(key) as
              | { count: number }
              | undefined
          )?.count ?? 0,
        );
      if (used(day) >= daily || used(month) >= monthly) {
        this.db.exec("ROLLBACK");
        return false;
      }
      for (const key of [day, month])
        this.db
          .prepare(
            "INSERT INTO quota VALUES(?,1) ON CONFLICT(key) DO UPDATE SET count=count+1",
          )
          .run(key);
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  cleanup(now = Date.now()) {
    this.db.prepare("DELETE FROM snapshots WHERE at < ? AND key NOT LIKE 'pinata:%' AND key NOT LIKE 'buyback:index:%'").run(now - 86400000);
    this.db
      .prepare("DELETE FROM quota WHERE key < ?")
      .run(new Date(now - 100 * 86400000).toISOString().slice(0, 7));
    this.db
      .prepare(
        "DELETE FROM plans WHERE CAST(COALESCE(json_extract(payload,'$.preparedAt'),json_extract(payload,'$.plan.preparedAt')) AS INTEGER) < ? AND id NOT IN (SELECT plan_id FROM pending_launches) AND id NOT IN (SELECT id FROM protected_plans)",
      )
      .run(now - 30 * 86400000);
    this.db
      .prepare(
        "DELETE FROM pending_launches WHERE status IN ('failed','replaced') AND updated_at < ?",
      )
      .run(now - 30 * 86400000);
  }
  trackLaunch(hash: string, planId: string) {
    if (!this.db.prepare("SELECT id FROM plans WHERE id=?").get(planId))
      throw new Error("Launch preview not found");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pending_launches (hash,plan_id,status,block_hash,updated_at) VALUES(?,?, 'pending',NULL,?)",
      )
      .run(hash.toLowerCase(), planId, Date.now());
  }
  pendingLaunches(now = Date.now()) {
    const rows = this.db
      .prepare(
        "SELECT hash,plan_id AS planId,status,block_hash AS blockHash,retry_at AS retryAt,attempts,finalized FROM pending_launches WHERE status NOT IN ('failed','replaced') AND finalized=0 AND retry_at<=? ORDER BY retry_at,updated_at LIMIT 100",
      )
      .all(now) as unknown as {
      retryAt: number; attempts: number; finalized: boolean;
      hash: Hex;
      planId: string;
      status: string;
      blockHash: string | null;
    }[];
    return rows.map(row=>({...row,finalized:!!row.finalized}));
  }
  launchStatus(hash: string, status: string, blockHash: string | null = null) {
    this.db
      .prepare(
        "UPDATE pending_launches SET status=?,block_hash=?,updated_at=? WHERE hash=?",
      )
      .run(status, blockHash, Date.now(), hash.toLowerCase());
    if (status === "confirmed")
      this.db
        .prepare(
          "UPDATE pending_launches SET status='replaced',updated_at=? WHERE hash<>? AND plan_id=(SELECT plan_id FROM pending_launches WHERE hash=?)",
        )
        .run(Date.now(), hash.toLowerCase(), hash.toLowerCase());
  }
  removeToken(hash: string) {
    this.db
      .prepare("DELETE FROM tokens WHERE lower(tx_hash)=?")
      .run(hash.toLowerCase());
  }
  savePlan(plan: LaunchPlan) {
    this.db
      .prepare("INSERT OR REPLACE INTO plans VALUES(?,?,?,?)")
      .run(
        plan.id,
        plan.creator.toLowerCase(),
        plan.data,
        JSON.stringify(packPlan(plan)),
      );
  }
  findPlan(creator: string, data: string) {
    const row = this.db
      .prepare("SELECT payload FROM plans WHERE creator=? AND data=? LIMIT 1")
      .get(creator.toLowerCase(), data) as { payload: string } | undefined;
    return row ? unpackPlan(JSON.parse(row.payload)) : null;
  }
  saveToken(token: TokenRecord) {
    this.db
      .prepare("INSERT OR IGNORE INTO tokens VALUES(?,?,?,?)")
      .run(
        token.address.toLowerCase(),
        token.transactionHash,
        token.createdAt,
        JSON.stringify(token),
      );
  }
  /** Provenance only ever improves: replaces a token record still marked with
   * an unverified opening valuation by the same launch, now proven. */
  upgradeTokenProvenance(token: TokenRecord) {
    if (token.openingValuationUnverified || !token.transactionHash) return;
    this.db
      .prepare("UPDATE tokens SET payload=? WHERE address=? AND lower(tx_hash)=lower(?) AND json_extract(payload,'$.openingValuationUnverified') IS NOT NULL")
      .run(JSON.stringify(token), token.address.toLowerCase(), token.transactionHash);
  }
  tokens(): TokenRecord[] {
    return (
      this.db
        .prepare("SELECT payload FROM tokens ORDER BY created_at DESC")
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  token(address: string): TokenRecord | null {
    const row = this.db
      .prepare("SELECT payload FROM tokens WHERE address=?")
      .get(address.toLowerCase()) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
}
