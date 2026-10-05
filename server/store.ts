import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { LaunchInput } from "../src/lib/validation";
import type { TokenRecord } from "../src/lib/config";
import type { FeePolicy } from "../src/lib/fee-policy";
import type { OpeningValuation } from "../src/lib/opening-valuation";
export type LaunchPlan = {
  id: Hex;
  creator: Address;
  data: Hex;
  tokenAddress: Address;
  poolId: Hex;
  draft: LaunchInput & { openingCap?: string };
  preparedAt: number;
  gas: string | null;
  feePolicy?: FeePolicy;
  feeTreasury?: Address;
  openingValuation?: OpeningValuation;
};
export type BuybackBatchRecord = Record<string, unknown> & { id: string };
export function assertBuybackBatchId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 200)
    throw new Error("Invalid buyback batch ID");
}
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string, chainId: number) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "launchpad.sqlite"));
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
    this.db
      .prepare("INSERT OR IGNORE INTO metadata VALUES (?, ?)")
      .run("chainId", String(chainId));
    const stored = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get("chainId") as { value: string };
    if (stored.value !== String(chainId)) {
      this.db.close();
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
  }
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
    this.db.prepare("DELETE FROM snapshots WHERE at < ?").run(now - 86400000);
    this.db
      .prepare("DELETE FROM quota WHERE key < ?")
      .run(new Date(now - 100 * 86400000).toISOString().slice(0, 7));
    this.db
      .prepare(
        "DELETE FROM plans WHERE CAST(json_extract(payload,'$.preparedAt') AS INTEGER) < ? AND id NOT IN (SELECT plan_id FROM pending_launches)",
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
        "INSERT OR IGNORE INTO pending_launches VALUES(?,?, 'pending',NULL,?)",
      )
      .run(hash.toLowerCase(), planId, Date.now());
  }
  pendingLaunches() {
    return this.db
      .prepare(
        "SELECT hash,plan_id AS planId,status,block_hash AS blockHash FROM pending_launches WHERE status NOT IN ('failed','replaced') ORDER BY updated_at LIMIT 100",
      )
      .all() as {
      hash: Hex;
      planId: string;
      status: string;
      blockHash: string | null;
    }[];
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
        JSON.stringify(plan),
      );
  }
  findPlan(creator: string, data: string) {
    const row = this.db
      .prepare("SELECT payload FROM plans WHERE creator=? AND data=? LIMIT 1")
      .get(creator.toLowerCase(), data) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as LaunchPlan) : null;
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
