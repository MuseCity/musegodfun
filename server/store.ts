import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { packPlan, unpackPlan } from "./plan-storage";
import { BUDGETS, defaultRuntimeControl, type RuntimeControl, type BudgetName, type BudgetResult } from "./runtime-policy";
import type { Address, Hex } from "viem";
import type { TokenRecord } from "../src/lib/config";
import type { LaunchPlan } from "../src/lib/launch-plan";
import { assertVaultAmount, assertVaultBaseFill, assertVaultCommit, type VaultLedgerState, type VaultLedgerCommit, type VaultLedgerEvent, type VaultLedgerBlock, type VaultEventCursor } from "../src/lib/buyback-vault-ledger";
import { assertCustodyCommit, assertCustodyEvent, assertCustodyFragments, type CustodyCommit, type CustodyEvent, type CustodyLedgerId, type CustodyState } from "../src/lib/buyback-custody-ledger";
export type { LaunchPlan } from "../src/lib/launch-plan";
export type BuybackBatchRecord = Record<string, unknown> & { id: string };
export type BuybackBatchPageRecord = BuybackBatchRecord & { updatedAt: number };
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
      CREATE TABLE IF NOT EXISTS vault_ledger_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vault_ledger_blocks (number INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vault_ledger_events (id TEXT PRIMARY KEY, block_number INTEGER NOT NULL, transaction_index INTEGER NOT NULL, log_index INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS vault_ledger_position ON vault_ledger_events(block_number,transaction_index,log_index);
      CREATE TABLE IF NOT EXISTS custody_ledger_state (id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS custody_ledger_blocks (ledger_id TEXT NOT NULL,number INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(ledger_id,number));
      CREATE TABLE IF NOT EXISTS custody_ledger_events (ledger_id TEXT NOT NULL,id TEXT NOT NULL,block_number INTEGER NOT NULL,transaction_index INTEGER NOT NULL,log_index INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(ledger_id,id));
      CREATE UNIQUE INDEX IF NOT EXISTS custody_ledger_position ON custody_ledger_events(ledger_id,block_number,transaction_index,log_index);
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
  listBuybackBatches(): BuybackBatchRecord[] {
    return (this.db.prepare(
      "SELECT payload FROM buyback_batches ORDER BY updated_at DESC,id LIMIT 1000",
    ).all() as { payload: string }[]).map((row) => JSON.parse(row.payload));
  }
  buybackBatchPage(limit = 100, before?: { updatedAt: number; id: string }): BuybackBatchPageRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid buyback batch page size");
    if (before) {
      assertBuybackBatchId(before.id);
      if (!Number.isSafeInteger(before.updatedAt) || before.updatedAt < 0) throw new Error("Invalid buyback batch cursor");
    }
    const rows = before
      ? this.db.prepare("SELECT payload,updated_at FROM buyback_batches WHERE updated_at<? OR (updated_at=? AND id>?) ORDER BY updated_at DESC,id LIMIT ?")
        .all(before.updatedAt, before.updatedAt, before.id, limit)
      : this.db.prepare("SELECT payload,updated_at FROM buyback_batches ORDER BY updated_at DESC,id LIMIT ?").all(limit);
    return (rows as { payload: string; updated_at: number }[]).map(row => ({ ...JSON.parse(row.payload), updatedAt: row.updated_at }));
  }
  private assertVaultLedgerAuthority() {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key='chainId'").get() as { value: string };
    if (!["4663", "31337"].includes(row.value)) throw new Error("Vault ledger belongs to the Robinhood store");
  }
  vaultLedgerState(): VaultLedgerState | null {
    this.assertVaultLedgerAuthority();
    const row = this.db.prepare("SELECT payload FROM vault_ledger_state WHERE id=1").get() as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  vaultLedgerEventPage(limit = 500, after?: VaultEventCursor): VaultLedgerEvent[] {
    this.assertVaultLedgerAuthority();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid vault ledger page size");
    if (after) {
      assertVaultAmount(after.blockNumber);
      if (![after.transactionIndex, after.logIndex].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid vault event cursor");
    }
    const rows = after
      ? this.db.prepare("SELECT payload FROM vault_ledger_events WHERE (block_number,transaction_index,log_index)>(?,?,?) ORDER BY block_number,transaction_index,log_index LIMIT ?")
        .all(BigInt(after.blockNumber), after.transactionIndex, after.logIndex, limit)
      : this.db.prepare("SELECT payload FROM vault_ledger_events ORDER BY block_number,transaction_index,log_index LIMIT ?").all(limit);
    return (rows as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  vaultLedgerBlockPage(limit = 500, before?: string): VaultLedgerBlock[] {
    this.assertVaultLedgerAuthority();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid vault ledger page size");
    if (before !== undefined) assertVaultAmount(before);
    const rows = before !== undefined
      ? this.db.prepare("SELECT payload FROM vault_ledger_blocks WHERE number<? ORDER BY number DESC LIMIT ?").all(BigInt(before), limit)
      : this.db.prepare("SELECT payload FROM vault_ledger_blocks ORDER BY number DESC LIMIT ?").all(limit);
    return (rows as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  commitVaultLedger(input: VaultLedgerCommit): VaultLedgerState {
    this.assertVaultLedgerAuthority();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertVaultCommit(input, this.vaultLedgerState());
      if (input.rollbackAfterBlock !== undefined) {
        this.db.prepare("DELETE FROM vault_ledger_events WHERE block_number>?").run(BigInt(input.rollbackAfterBlock));
        this.db.prepare("DELETE FROM vault_ledger_blocks WHERE number>?").run(BigInt(input.rollbackAfterBlock));
      }
      for (const block of input.blocks) {
        const old = this.db.prepare("SELECT payload FROM vault_ledger_blocks WHERE number=?").get(BigInt(block.number)) as { payload: string } | undefined;
        if (old && old.payload !== JSON.stringify(block)) throw new Error("Conflicting canonical vault block; roll back first");
        this.db.prepare("INSERT OR IGNORE INTO vault_ledger_blocks VALUES(?,?)").run(BigInt(block.number), JSON.stringify(block));
      }
      for (const event of input.events) {
        const canonical = this.db.prepare("SELECT payload FROM vault_ledger_blocks WHERE number=?").get(BigInt(event.blockNumber)) as { payload: string } | undefined;
        if (!canonical || JSON.parse(canonical.payload).hash.toLowerCase() !== event.blockHash.toLowerCase()) throw new Error("Vault event does not match indexed canonical block");
        const old = this.db.prepare("SELECT payload FROM vault_ledger_events WHERE id=?").get(event.id) as { payload: string } | undefined;
        if (old && old.payload !== JSON.stringify(event)) throw new Error("Conflicting canonical vault event");
        this.db.prepare("INSERT OR IGNORE INTO vault_ledger_events VALUES(?,?,?,?,?)").run(event.id, BigInt(event.blockNumber), event.transactionIndex, event.logIndex, JSON.stringify(event));
      }
      for (const classification of input.classifications || []) {
        const old = this.db.prepare("SELECT payload FROM vault_ledger_events WHERE id=?").get(classification.eventId) as { payload: string } | undefined;
        if (!old) throw new Error("Vault transfer not indexed");
        const event = JSON.parse(old.payload) as VaultLedgerEvent;
        if (event.kind !== "weth_in" || !["base", "robinhood_engine", "donation", "unknown"].includes(classification.source)) throw new Error("Invalid vault source classification");
        if (!classification.revalidate && event.source !== "unknown" && JSON.stringify({ source: event.source, baseFill: event.baseFill }) !== JSON.stringify({ source: classification.source, baseFill: classification.baseFill })) throw new Error("Vault source classification is already verified");
        if (classification.source === "base") assertVaultBaseFill(event, classification.baseFill!, input.state);
        const {baseFill: _previousFill, ...rawEvent}=event;
        const changed = { ...rawEvent, source: classification.source, ...(classification.baseFill ? { baseFill: classification.baseFill } : {}) };
        this.db.prepare("UPDATE vault_ledger_events SET payload=? WHERE id=?").run(JSON.stringify(changed), event.id);
      }
      this.db.prepare("INSERT INTO vault_ledger_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload")
        .run(input.state.revision, JSON.stringify(input.state));
      this.db.exec("COMMIT"); return input.state;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private assertCustodyAuthority(id: CustodyLedgerId) {
    if (!["base_automation", "robinhood_treasury"].includes(id)) throw new Error("Invalid custody journal identity");
    const chain = (this.db.prepare("SELECT value FROM metadata WHERE key='chainId'").get() as {value:string}).value;
    if (chain !== "31337" && chain !== (id === "base_automation" ? "8453" : "4663")) throw new Error("Custody journal belongs to another chain");
  }
  custodyLedgerState(id: CustodyLedgerId): CustodyState | null {
    this.assertCustodyAuthority(id);
    const row = this.db.prepare("SELECT payload FROM custody_ledger_state WHERE id=?").get(id) as {payload:string}|undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  custodyLedgerEventPage(id: CustodyLedgerId, limit = 500, after?: VaultEventCursor): CustodyEvent[] {
    this.assertCustodyAuthority(id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid custody page size");
    if (after) { assertVaultAmount(after.blockNumber); if (![after.transactionIndex, after.logIndex].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid custody cursor"); }
    const rows = after ? this.db.prepare("SELECT payload FROM custody_ledger_events WHERE ledger_id=? AND (block_number,transaction_index,log_index)>(?,?,?) ORDER BY block_number,transaction_index,log_index LIMIT ?")
      .all(id, BigInt(after.blockNumber), after.transactionIndex, after.logIndex, limit)
      : this.db.prepare("SELECT payload FROM custody_ledger_events WHERE ledger_id=? ORDER BY block_number,transaction_index,log_index LIMIT ?").all(id, limit);
    return (rows as {payload:string}[]).map(row => JSON.parse(row.payload));
  }
  custodyLedgerBlockPage(id: CustodyLedgerId, limit = 500, before?: string): VaultLedgerBlock[] {
    this.assertCustodyAuthority(id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid custody page size");
    if (before !== undefined) assertVaultAmount(before);
    const rows = before === undefined ? this.db.prepare("SELECT payload FROM custody_ledger_blocks WHERE ledger_id=? ORDER BY number DESC LIMIT ?").all(id,limit)
      : this.db.prepare("SELECT payload FROM custody_ledger_blocks WHERE ledger_id=? AND number<? ORDER BY number DESC LIMIT ?").all(id,BigInt(before),limit);
    return (rows as {payload:string}[]).map(row => JSON.parse(row.payload));
  }
  commitCustodyLedger(input: CustodyCommit): CustodyState {
    this.assertCustodyAuthority(input.state.id);
    const id = input.state.id;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertCustodyCommit(input, this.custodyLedgerState(id));
      if (input.rollbackAfterBlock !== undefined) {
        this.db.prepare("DELETE FROM custody_ledger_events WHERE ledger_id=? AND block_number>?").run(id,BigInt(input.rollbackAfterBlock));
        this.db.prepare("DELETE FROM custody_ledger_blocks WHERE ledger_id=? AND number>?").run(id,BigInt(input.rollbackAfterBlock));
      }
      for (const block of input.blocks) {
        const old = this.db.prepare("SELECT payload FROM custody_ledger_blocks WHERE ledger_id=? AND number=?").get(id,BigInt(block.number)) as {payload:string}|undefined;
        if (old && old.payload !== JSON.stringify(block)) throw new Error("Conflicting canonical custody block; rollback first");
        this.db.prepare("INSERT OR IGNORE INTO custody_ledger_blocks VALUES(?,?,?)").run(id,BigInt(block.number),JSON.stringify(block));
      }
      for (const event of input.events) {
        const canonical = this.db.prepare("SELECT payload FROM custody_ledger_blocks WHERE ledger_id=? AND number=?").get(id,BigInt(event.blockNumber)) as {payload:string}|undefined;
        if (!canonical || JSON.parse(canonical.payload).hash.toLowerCase() !== event.blockHash.toLowerCase()) throw new Error("Custody event lacks indexed canonical block");
        const old = this.db.prepare("SELECT payload FROM custody_ledger_events WHERE ledger_id=? AND id=?").get(id,event.id) as {payload:string}|undefined;
        if (old && old.payload !== JSON.stringify(event)) throw new Error("Conflicting canonical custody event");
        this.db.prepare("INSERT OR IGNORE INTO custody_ledger_events VALUES(?,?,?,?,?,?)").run(id,event.id,BigInt(event.blockNumber),event.transactionIndex,event.logIndex,JSON.stringify(event));
      }
      for (const classification of input.classifications ?? []) {
        const old = this.db.prepare("SELECT payload FROM custody_ledger_events WHERE ledger_id=? AND id=?").get(id,classification.eventId) as {payload:string}|undefined;
        if (!old) throw new Error("Custody transfer not indexed");
        const event = JSON.parse(old.payload) as CustodyEvent;
        assertCustodyFragments(classification.fragments,event.amount);
        if (event.kind !== "in") throw new Error("Cannot classify custody outflow");
        if (!classification.revalidate && event.evidence && JSON.stringify({fragments:event.fragments,evidence:event.evidence}) !== JSON.stringify({fragments:classification.fragments,evidence:classification.evidence})) throw new Error("Custody provenance is already verified");
        const changed = {...event,fragments:classification.fragments,evidence:classification.evidence}; assertCustodyEvent(changed,input.state);
        this.db.prepare("UPDATE custody_ledger_events SET payload=? WHERE ledger_id=? AND id=?").run(JSON.stringify(changed),id,event.id);
      }
      this.db.prepare("INSERT INTO custody_ledger_state VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload").run(id,input.state.revision,JSON.stringify(input.state));
      this.db.exec("COMMIT"); return input.state;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  backup(): Record<string, unknown> {
    // SQLite backups include runtime controls and the complete journal, with no display-list caps.
    const tables = ["metadata", "plans", "tokens", "snapshots", "quota", "pending_launches", "buyback_batches", "protected_plans", "runtime_control", "vault_ledger_state", "vault_ledger_blocks", "vault_ledger_events", "custody_ledger_state", "custody_ledger_blocks", "custody_ledger_events"];
    this.db.exec("BEGIN");
    try {
      const backup = { version: 3, sqlite: true, tables: Object.fromEntries(tables.map(table => [table, this.db.prepare(`SELECT * FROM ${table}`).all()])) };
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
      if (tables.some(table => !!this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) throw new Error("Restore target is not empty");
      for (const table of tables) {
        const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
        for (const row of value.tables[table] || []) this.db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
          .run(...columns.map(column => row[column] as string | number | null));
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
