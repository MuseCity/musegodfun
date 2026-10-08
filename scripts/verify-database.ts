import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SupabaseStore } from "../server/supabase-store";
import { loadEnvironment } from "../server/config";
import { STOCKS, type TokenRecord } from "../src/lib/config";
import type { LaunchPlan } from "../server/store";
import { FEE_POLICY } from "../src/lib/fee-policy";
loadEnvironment();
const id = randomUUID(),
  scope = `verify-${id}`,
  restored = `restore-${id}`,
  legacyScope = `restore-legacy-${id}`,
  occupiedScope = `restore-occupied-${id}`;
const connect = (s: string) =>
  new SupabaseStore(
    process.env.SUPABASE_URL || "",
    process.env.SUPABASE_SECRET_KEY || "",
    s,
  );
const store = connect(scope),
  restore = connect(restored),
  legacy = connect(legacyScope),
  occupied = connect(occupiedScope);
let connected = false;
try {
  await store.health();
  connected = true;
  const now = Date.now();
  const reserved = await Promise.all(
    Array.from({ length: 6 }, () => store.reserveMarketCall(now, 1, 2)),
  );
  assert.equal(
    reserved.filter(Boolean).length,
    1,
    "Concurrent budget reservation must be atomic",
  );
  assert.equal(
    await connect(scope).reserveMarketCall(now, 1, 2),
    false,
    "Budget survives a new connection",
  );
  const data = { fetchedAt: new Date().toISOString(), priceUsd: 1 };
  await store.saveSnapshot("fixture", data, now);
  assert.deepEqual((await connect(scope).snapshot("fixture"))?.data, data);
  // Exercise registration persistence only in disposable scopes. These records
  // are fixtures, not claims that a mainnet transaction was sent or verified.
  const plan: LaunchPlan = {
    id: `0x${"1".repeat(64)}`,
    creator: STOCKS[0].address,
    data: "0x1234",
    tokenAddress: STOCKS[1].address,
    poolId: `0x${"2".repeat(64)}`,
    draft: { name: "Database fixture", symbol: "DBTEST", description: "", image: "", quoteAddress: STOCKS[0].address, openingCap: "100" },
    preparedAt: now,
    gas: null,
    feePolicy: FEE_POLICY,
    feeTreasury: STOCKS[3].address,
  };
  const hash = `0x${"3".repeat(64)}` as const;
  const replacedHash = `0x${"4".repeat(64)}` as const;
  const blockHash = `0x${"5".repeat(64)}`;
  await store.savePlanIfAbsent(plan);
  await store.savePlanIfAbsent({ ...plan, gas: "1" });
  assert.deepEqual(await connect(scope).findPlan(plan.creator, plan.data), plan, "An existing plan is never replaced by savePlanIfAbsent");
  await store.savePlan(plan);
  assert.deepEqual(await connect(scope).findPlan(plan.creator, plan.data), plan);
  assert.equal(await store.findPlan(STOCKS[2].address, plan.data), null);
  await store.trackLaunch(hash, plan.id);
  await store.trackLaunch(replacedHash, plan.id);
  assert.equal((await connect(scope).pendingLaunches()).length, 2);
  const token: TokenRecord = {
    ...plan.draft, openingCap: plan.draft.openingCap!, address: plan.tokenAddress, creator: plan.creator,
    poolId: plan.poolId, transactionHash: hash, blockNumber: "1", createdAt: now, mode: "base",
    feePolicy: plan.feePolicy, feeTreasury: plan.feeTreasury,
  };
  await store.saveToken({ ...token, openingValuationUnverified: true });
  await store.saveToken(token);
  assert.equal((await connect(scope).tokens()).length, 1);
  assert.equal((await connect(scope).tokenByTxHash(hash))?.openingValuationUnverified, true, "A token record is written once");
  await store.upgradeTokenProvenance(token);
  assert.equal((await connect(scope).tokenByTxHash(hash))?.openingValuationUnverified, undefined, "A proven opening valuation upgrades it in place");
  await store.upgradeTokenProvenance({ ...token, openingValuationUnverified: true });
  assert.equal((await connect(scope).tokenByTxHash(hash))?.openingValuationUnverified, undefined, "Provenance never downgrades");
  await store.launchStatus(hash, "confirmed", blockHash);
  const queue = await connect(scope).pendingLaunches();
  assert.equal(queue.length, 1, "Replacement must leave the active queue");
  assert.equal(queue[0].status, "confirmed");
  assert.equal(queue[0].blockHash, blockHash);
  const batch = {
    id: `fixture-${id}`,
    status: "pending",
    amountIn: "123456789012345678901234567890",
    sourceChainId: 8453,
    destinationChainId: 4663,
    transactionHashes: [hash],
    receipt: { blockHash, amount: "987654321098765432109876543210" },
  };
  await store.saveBuybackBatch(batch);
  assert.deepEqual(await connect(scope).getBuybackBatch(batch.id), batch);
  assert.equal(await restore.getBuybackBatch(batch.id), null, "Batch scopes must remain isolated");
  const confirmedBatch = { ...batch, status: "burn_confirmed" };
  await store.saveBuybackBatch(confirmedBatch);
  assert.deepEqual(await store.listBuybackBatches(), [confirmedBatch], "Batch upsert must not duplicate history");
  const backup = await store.backup();
  assert.equal(backup.version, 2);
  await restore.restore(backup);
  assert.deepEqual((await restore.snapshot("fixture"))?.data, data);
  assert.deepEqual(await restore.token(token.address), token);
  assert.deepEqual(await restore.pendingLaunches(), queue);
  assert.deepEqual(await restore.getBuybackBatch(batch.id), confirmedBatch);
  const historicalBackup: Record<string, unknown> = { ...backup, version: 1 };
  delete historicalBackup.buyback_batches;
  await legacy.restore(historicalBackup);
  assert.deepEqual(await legacy.token(token.address), token, "Historical version-1 backups remain readable");
  assert.deepEqual(await legacy.listBuybackBatches(), [], "Absent legacy batch field restores as empty");
  await occupied.saveBuybackBatch(confirmedBatch);
  await assert.rejects(() => occupied.restore(historicalBackup), /Database request failed/, "A scope containing only a batch must reject restore");
  await store.cleanup(now + 25 * 60 * 60 * 1000);
  assert.deepEqual(await store.getBuybackBatch(batch.id), confirmedBatch, "Snapshot cleanup must retain batch receipts");
  await restore.removeToken(hash);
  assert.equal(await restore.token(token.address), null);
  assert.equal(
    await restore.reserveMarketCall(now, 1, 2),
    false,
    "Restore must retain used quota",
  );
  await assert.rejects(() => restore.restore(backup), /Database request failed/);
  await writeFile(
    "docs/evidence/database.json",
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        backend: "Supabase",
        project: new URL(process.env.SUPABASE_URL || "").hostname.split(".")[0],
        scope: "isolated verification rows only",
        checks: [
          "health",
          "atomic concurrent quota",
          "quota survives reconnect",
          "snapshot readback",
          "consistent backup / empty target restore",
          "restore preserves quota",
          "nonempty restore rejected",
          "launch plan and pending hash survive reconnect",
          "fee policy and original treasury survive reconnect and backup restore",
          "idempotent token registration and replacement status",
          "backup restores token and canonical receipt identity",
          "orphan token removal",
          "buyback batch amounts and receipt history survive reconnect and upsert",
          "buyback batch scope isolation and 24-hour cleanup retention",
          "version-2 backup preserves buyback batches",
          "version-1 backup without buyback batches restores successfully",
          "restore cannot overwrite a scope containing only buyback batches",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS: Supabase persistence, concurrency and backup / restore");
} finally {
  for (const db of connected ? [store, restore, legacy, occupied] : []) {
    assert(/^(verify|restore)-/.test(db.scope));
    for (const table of [
      "pending_launches",
      "tokens",
      "plans",
      "snapshots",
      "quota",
      "buyback_batches",
    ])
      await db.request(`musegod_${table}?scope=eq.${db.scope}`, "DELETE");
  }
}
