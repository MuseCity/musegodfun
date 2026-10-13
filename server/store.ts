import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { packPlan, unpackPlan } from "./plan-storage";
import { BUDGETS, defaultRuntimeControl, type RuntimeControl, type BudgetName, type BudgetResult } from "./runtime-policy";
import type { Address, Hex } from "viem";
import type { TokenRecord } from "../src/lib/config";
import type { LaunchPlan } from "../src/lib/launch-plan";
function assertSequence(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error("Invalid history sequence");
}
export type { LaunchPlan } from "../src/lib/launch-plan";
/** NFT mode's two single-use rules, enforced by the database for every writer (each server runtime and `npm run nft:reverify`): one
 * launch-fee payment funds one coin (`launch_fee`), and each NFT has at most one `verified` coin (`nft_verified`). Partial unique indexes
 * whose expressions are exactly the predicates of `tokenUsingLaunchFee` and `verifiedNftCoin`, in SQLite (below) and in Supabase
 * (`supabase/migrations/20261014120000_nft_single_use_indexes.sql`, scoped). A refusal is recognised by index name only. */
export const TOKEN_UNIQUE_INDEXES = {
  launch_fee: { sqlite: "tokens_launch_fee_once", postgres: "musegod_tokens_launch_fee_once" },
  nft_verified: { sqlite: "tokens_nft_verified_once", postgres: "musegod_tokens_nft_verified_once" },
} as const;
export type TokenUniqueKind = keyof typeof TOKEN_UNIQUE_INDEXES;
const TOKEN_UNIQUE_KINDS = Object.keys(TOKEN_UNIQUE_INDEXES) as TokenUniqueKind[];
/** The database refused a token write: another coin already spent this launch fee, or already holds this NFT `verified`. Registration
 * settles the coin `rejected: fee` or `rejected: already_launched`; `nft:reverify` reports a CONFLICT. */
export class TokenUniqueConflict extends Error {
  constructor(readonly kind: TokenUniqueKind) {
    super(kind === "launch_fee" ? "This launch fee was already used by another coin." : "This NFT already has its verified coin.");
    this.name = "TokenUniqueConflict";
  }
}
/** SQLITE_CONSTRAINT_UNIQUE (2067) on one of the guard indexes, by name; null for any other error. */
export function sqliteTokenConflict(error: unknown): TokenUniqueConflict | null {
  if (!(error instanceof Error) || (error as { errcode?: unknown }).errcode !== 2067) return null;
  const kind = TOKEN_UNIQUE_KINDS.find((name) => error.message.includes(`UNIQUE constraint failed: index '${TOKEN_UNIQUE_INDEXES[name].sqlite}'`));
  return kind ? new TokenUniqueConflict(kind) : null;
}
/** A PostgREST error body for Postgres code 23505 on one of the guard indexes, by name; null for any other body, including the
 * `(scope,address)` and `(scope,tx_hash)` keys. */
export function postgresTokenConflict(body: string): TokenUniqueConflict | null {
  let error: unknown;
  try { error = JSON.parse(body); } catch { return null; }
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code !== "23505" || typeof message !== "string") return null;
  const kind = TOKEN_UNIQUE_KINDS.find((name) => message.includes(`"${TOKEN_UNIQUE_INDEXES[name].postgres}"`));
  return kind ? new TokenUniqueConflict(kind) : null;
}
export type BuybackBatchRecord = Record<string, unknown> & { id: string };
export type BuybackBatchPageRecord = BuybackBatchRecord & { updatedAt: number; sequence: string };
export function assertBuybackBatchId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 200)
    throw new Error("Invalid buyback batch ID");
}
export function assertBuybackAuditRecord(value:unknown):asserts value is BuybackBatchRecord {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid internal native audit metadata");
  const record=value as BuybackBatchRecord;assertBuybackBatchId(record.id);
  if(!record.id.startsWith("internal_native_")||typeof record.protocol!=="string"||!/^internal_native_[a-z0-9_]+$/.test(record.protocol))throw new Error("Only internal native audit metadata can use audit CAS");
}
// Historical schemas are restored only by the explicit empty-target restore
// tool. Normal startup never creates, writes or deletes a retired ledger.
const legacyLedgerSchemas: Record<string,string> = {
  vault_ledger_state: "CREATE TABLE vault_ledger_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,payload TEXT NOT NULL)",
  vault_ledger_blocks: "CREATE TABLE vault_ledger_blocks(number INTEGER PRIMARY KEY,payload TEXT NOT NULL)",
  vault_ledger_events: "CREATE TABLE vault_ledger_events(id TEXT PRIMARY KEY,block_number INTEGER NOT NULL,transaction_index INTEGER NOT NULL,log_index INTEGER NOT NULL,payload TEXT NOT NULL)",
  custody_ledger_state: "CREATE TABLE custody_ledger_state(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL)",
  custody_ledger_blocks: "CREATE TABLE custody_ledger_blocks(ledger_id TEXT NOT NULL,number INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(ledger_id,number))",
  custody_ledger_events: "CREATE TABLE custody_ledger_events(ledger_id TEXT NOT NULL,id TEXT NOT NULL,block_number INTEGER NOT NULL,transaction_index INTEGER NOT NULL,log_index INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(ledger_id,id))",
};
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
    // TOKEN_UNIQUE_INDEXES: the stored JSON keeps nft.chainId a number and nft.tokenId a decimal string, as verifiedNftCoin reads them.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${TOKEN_UNIQUE_INDEXES.launch_fee.sqlite} ON tokens(lower(json_extract(payload,'$.launchFee.txHash')))
        WHERE json_extract(payload,'$.launchFee.txHash') IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ${TOKEN_UNIQUE_INDEXES.nft_verified.sqlite} ON tokens(json_extract(payload,'$.nft.chainId'),
        lower(json_extract(payload,'$.nft.contract')), json_extract(payload,'$.nft.tokenId')) WHERE json_extract(payload,'$.nftVerification.status')='verified';`);
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
    const now = Date.now();
    const updatedAt = typeof batch.updatedAt === "number" && Number.isSafeInteger(batch.updatedAt) && batch.updatedAt >= 0 && batch.updatedAt <= now ? batch.updatedAt : now;
    this.db.prepare(
      "INSERT INTO buyback_batches VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload",
    ).run(batch.id, updatedAt, JSON.stringify(batch));
  }
  getBuybackBatch(id: string): BuybackBatchRecord | null {
    assertBuybackBatchId(id);
    const row = this.db.prepare("SELECT payload FROM buyback_batches WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  compareAndSetBuybackAudit(next:BuybackBatchRecord,expected:BuybackBatchRecord|null):boolean {
    assertBuybackAuditRecord(next);if(expected!==null){assertBuybackAuditRecord(expected);if(expected.id!==next.id)throw new Error("Internal audit CAS identity differs");}
    const normalizedExpected=expected===null?null:JSON.parse(JSON.stringify(expected));
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const current=this.getBuybackBatch(next.id);
      if(!isDeepStrictEqual(current,normalizedExpected)){this.db.exec("ROLLBACK");return false;}
      this.saveBuybackBatch(next);this.db.exec("COMMIT");return true;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  listBuybackBatches(): BuybackBatchRecord[] {
    return (this.db.prepare(
      "SELECT payload FROM buyback_batches ORDER BY updated_at DESC,id LIMIT 1000",
    ).all() as { payload: string }[]).map((row) => JSON.parse(row.payload));
  }
  buybackBatchPage(limit = 100, before?: { sequence: string }): BuybackBatchPageRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid buyback batch page size");
    if (before) assertSequence(before.sequence);
    const rows = before
      ? this.db.prepare("SELECT payload,updated_at,CAST(rowid AS TEXT) AS sequence FROM buyback_batches WHERE rowid<? ORDER BY rowid DESC LIMIT ?").all(BigInt(before.sequence),limit)
      : this.db.prepare("SELECT payload,updated_at,CAST(rowid AS TEXT) AS sequence FROM buyback_batches ORDER BY rowid DESC LIMIT ?").all(limit);
    return (rows as { payload: string; updated_at: number; sequence:string }[]).map(row => ({ ...JSON.parse(row.payload), updatedAt: row.updated_at,sequence:row.sequence }));
  }
  backup(): Record<string, unknown> {
    // SQLite backups include runtime controls and the complete journal, with no display-list caps.
    const tables = ["metadata", "plans", "tokens", "snapshots", "quota", "pending_launches", "buyback_batches", "protected_plans", "runtime_control", "vault_ledger_state", "vault_ledger_blocks", "vault_ledger_events", "custody_ledger_state", "custody_ledger_blocks", "custody_ledger_events"];
    this.db.exec("BEGIN");
    try {
      const existing = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
      const backup = { version: 3, sqlite: true, tables: Object.fromEntries(tables.filter(table=>existing.has(table)).map(table => [table, this.db.prepare(table === "buyback_batches" ? "SELECT *,CAST(rowid AS TEXT) AS sequence FROM buyback_batches" : `SELECT * FROM ${table}`).all()])) };
      this.db.exec("COMMIT"); return backup;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  restore(backup: unknown) {
    const value = backup as { version?: number; sqlite?: boolean; tables?: Record<string, Record<string, unknown>[]> };
    if (!value || value.version !== 3 || !value.sqlite || !value.tables || !Array.isArray(value.tables.metadata)) throw new Error("Unsupported SQLite backup");
    const tables = ["plans", "tokens", "snapshots", "quota", "pending_launches", "buyback_batches", "protected_plans", "runtime_control", "vault_ledger_state", "vault_ledger_blocks", "vault_ledger_events", "custody_ledger_state", "custody_ledger_blocks", "custody_ledger_events"];
    const sourceChain = value.tables.metadata.find(row => row.key === "chainId")?.value;
    const targetChain = (this.db.prepare("SELECT value FROM metadata WHERE key='chainId'").get() as { value: string }).value;
    if (sourceChain !== targetChain) throw new Error("Backup network does not match restore target");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
      if (tables.some(table => existing.has(table) && !!this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) throw new Error("Restore target is not empty");
      for (const table of tables) {
        if (!existing.has(table)) {
          if (!Object.hasOwn(value.tables,table)) continue;
          const schema = legacyLedgerSchemas[table];
          if (!schema) throw new Error("Restore target schema is unavailable");
          this.db.exec(schema);
        }
        const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
        for (const row of value.tables[table] || []) {
          const keys=table === "buyback_batches" && row.sequence !== undefined ? ["rowid",...columns] : columns;
          if(keys[0] === "rowid")assertSequence(row.sequence);
          this.db.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(column => column === "rowid" ? BigInt(row.sequence as string) : row[column] as string | number | null));
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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
  /** Saves a plan only if none with this id is stored yet. */
  savePlanIfAbsent(plan: LaunchPlan) {
    this.db
      .prepare("INSERT OR IGNORE INTO plans VALUES(?,?,?,?)")
      .run(plan.id, plan.creator.toLowerCase(), plan.data, JSON.stringify(packPlan(plan)));
  }
  findPlan(creator: string, data: string) {
    const row = this.db
      .prepare("SELECT payload FROM plans WHERE creator=? AND data=? LIMIT 1")
      .get(creator.toLowerCase(), data) as { payload: string } | undefined;
    return row ? unpackPlan(JSON.parse(row.payload)) : null;
  }
  /** Runs one token write; a refusal by a TOKEN_UNIQUE_INDEXES guard becomes a TokenUniqueConflict. */
  private writeToken(write: () => unknown) {
    try { write(); } catch (error) { throw sqliteTokenConflict(error) ?? error; }
  }
  /** A token is written once: a second registration of the same launch (address or transaction) changes nothing. Any other refusal
   * throws, so the guard indexes surface as a TokenUniqueConflict. */
  saveToken(token: TokenRecord) {
    this.writeToken(() => this.db
      .prepare("INSERT INTO tokens VALUES(?,?,?,?) ON CONFLICT(address) DO NOTHING ON CONFLICT(tx_hash) DO NOTHING")
      .run(token.address.toLowerCase(), token.transactionHash, token.createdAt, JSON.stringify(token)));
  }
  /** Provenance only ever improves: replaces a token record still marked with
   * an unverified opening valuation by the same launch, now proven. */
  upgradeTokenProvenance(token: TokenRecord) {
    if (token.openingValuationUnverified || !token.transactionHash) return;
    this.writeToken(() => this.db
      .prepare("UPDATE tokens SET payload=? WHERE address=? AND lower(tx_hash)=lower(?) AND json_extract(payload,'$.openingValuationUnverified') IS NOT NULL")
      .run(JSON.stringify(token), token.address.toLowerCase(), token.transactionHash));
  }
  /** Re-verification only settles an open NFT status: it replaces the record of the same launch only while that record has `nft`, a
   * status of `unverified` or none, and the opening-valuation provenance the caller read (so a concurrent provenance upgrade is never
   * reverted). Verified and rejected statuses are final, and records without `nft` are never touched. The guard indexes refuse a write
   * that would give the NFT a second `verified` coin or spend a fee another coin holds (a TokenUniqueConflict). */
  updateNftVerification(token: TokenRecord) {
    if (!token.nft || !token.transactionHash || !token.nftVerification) return;
    this.writeToken(() => this.db
      .prepare(`UPDATE tokens SET payload=? WHERE address=? AND lower(tx_hash)=lower(?) AND json_extract(payload,'$.nft') IS NOT NULL
        AND (json_extract(payload,'$.nftVerification.status') IS NULL OR json_extract(payload,'$.nftVerification.status')='unverified')
        AND json_extract(payload,'$.openingValuationUnverified') IS ?`)
      .run(JSON.stringify(token), token.address.toLowerCase(), token.transactionHash, token.openingValuationUnverified ? 1 : null));
  }
  tokens(): TokenRecord[] {
    return (
      this.db
        .prepare("SELECT payload FROM tokens ORDER BY created_at DESC")
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  /** The NFT's one coin whose identity passed verification (the verified-NFT guard index answers it, so there is at most one).
   * Rejected and unverified records never reserve an NFT. */
  verifiedNftCoin(key: string, excludeAddress?: string): TokenRecord | null {
    const [chainId, contract, tokenId] = key.split(":");
    const row = this.db.prepare(`SELECT payload FROM tokens WHERE json_extract(payload,'$.nft.chainId')=? AND lower(json_extract(payload,'$.nft.contract'))=?
      AND json_extract(payload,'$.nft.tokenId')=? AND json_extract(payload,'$.nftVerification.status')='verified' AND address<>? ORDER BY created_at ASC LIMIT 1`)
      .get(Number(chainId), contract.toLowerCase(), tokenId, (excludeAddress ?? "").toLowerCase()) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  /** The coin that already spent this launch-fee payment. A fee belongs to its payer: another wallet's coin carrying the hash never consumes it.
   * `excludeAddress` (the coin being registered or re-verified) is filtered in the query, so another holder is found whichever row comes first.
   * The launch-fee guard index answers it; it holds the hash alone, because a `launchFee` is stored only once it verified as sent by the
   * coin's creator, so a hash already names its one payer. */
  tokenUsingLaunchFee(txHash: string, creator: string, excludeAddress?: string): TokenRecord | null {
    const row = this.db.prepare(`SELECT payload FROM tokens WHERE json_extract(payload,'$.launchFee.txHash') IS NOT NULL
      AND lower(json_extract(payload,'$.launchFee.txHash'))=? AND lower(json_extract(payload,'$.creator'))=? AND address<>? LIMIT 1`).get(txHash.toLowerCase(), creator.toLowerCase(), (excludeAddress ?? "").toLowerCase()) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  token(address: string): TokenRecord | null {
    const row = this.db
      .prepare("SELECT payload FROM tokens WHERE address=?")
      .get(address.toLowerCase()) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
}
