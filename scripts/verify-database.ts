import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SupabaseStore } from "../server/supabase-store";
import { loadEnvironment } from "../server/config";
import { STOCKS, type TokenRecord } from "../src/lib/config";
import type { LaunchPlan } from "../server/store";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_VAULT, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_WETH, type BaseFeeBatch } from "../src/lib/base-buyback";
import { vaultEventId, type VaultLedgerEvent, type VaultLedgerState } from "../src/lib/buyback-vault-ledger";
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
  const sourceBatch: BaseFeeBatch = {
    id: `source-${id}`, protocol: BASE_BUYBACK_PROTOCOL, sourceChainId: 8453, destinationChainId: 4663,
    collector: STOCKS[3].address, kind: "native_relay", status: "unknown", createdAt: now, updatedAt: now,
    inputAsset: { chainId: 8453, address: BASE_BUYBACK_WETH, symbol: "WETH", decimals: 18 },
    amountIn: "1000000000000000", receivedAmount: "0", refundedAmount: "0", burnedAmount: "0", claimHashes: [], sourceHash: hash,
    journal: { caller: STOCKS[0].address, nonce: 7, to: STOCKS[3].address, dataHash: hash,
      hash, gasLimit: "250000", maxFeePerGas: "10000000", signedAt: now },
    replacements: [{ hash: replacedHash, cancelled: false, blockNumber: "1", blockHash: blockHash as `0x${string}` }],
  };
  await store.saveBuybackBatch(sourceBatch);
  assert.deepEqual(await connect(scope).getBuybackBatch(sourceBatch.id), sourceBatch, "An unknown source submission retains its original hash, nonce, gas and replacement proofs");
  const page = await store.buybackBatchPage(1), next = await store.buybackBatchPage(1, page[0]);
  assert.equal(new Set([...page, ...next].map(row => row.id)).size, 2, "Source batch keyset pages retain exact history");
  const checkpoint = { number: "0", hash: `0x${"6".repeat(64)}` as const, parentHash: `0x${"0".repeat(64)}` as const,
    wethBalance: "1000000000000000000", totalSpent: "7", totalBurned: "21", establishedAt: now };
  const cursor = { number: "1", hash: blockHash as `0x${string}`, parentHash: checkpoint.hash };
  const vaultState: VaultLedgerState = { version: 1, chainId: 4663, vault: BASE_BUYBACK_VAULT, weth: BASE_BUYBACK_RH_WETH,
    swapper: STOCKS[2].address, revision: 1, checkpoint, cursor, observedBalance: "1000000000000000021",
    observedTotalSpent: "7", observedTotalBurned: "21", updatedAt: now, blockedReason: null };
  const vaultEvent: VaultLedgerEvent = { id: vaultEventId(hash, 0), blockNumber: "1", blockHash: cursor.hash, transactionHash: hash,
    transactionIndex: 0, logIndex: 0, kind: "weth_in", from: STOCKS[3].address, to: BASE_BUYBACK_VAULT, amount: "21", source: "unknown" };
  const checkpointBlock = { number: checkpoint.number, hash: checkpoint.hash, parentHash: checkpoint.parentHash };
  await store.commitVaultLedger({ expectedRevision: 0, state: vaultState, blocks: [checkpointBlock, cursor], events: [vaultEvent] });
  assert.deepEqual(await connect(scope).vaultLedgerState(), vaultState);
  assert.deepEqual(await connect(scope).vaultLedgerEventPage(), [vaultEvent]);
  await store.updateRuntimeControl(true, "Isolated database verification fixture", 0);
  const backup = await store.backup();
  assert.equal(backup.version, 3);
  await restore.restore(backup);
  assert.deepEqual((await restore.snapshot("fixture"))?.data, data);
  assert.deepEqual(await restore.token(token.address), token);
  assert.deepEqual(await restore.pendingLaunches(), queue);
  assert.deepEqual(await restore.getBuybackBatch(batch.id), confirmedBatch);
  assert.deepEqual(await restore.getBuybackBatch(sourceBatch.id), sourceBatch, "Source unknown/reserved submissions cannot lose their original broadcast evidence during restore");
  assert.deepEqual(await restore.vaultLedgerState(), vaultState);
  assert.deepEqual(await restore.vaultLedgerEventPage(), [vaultEvent]);
  assert.deepEqual(await restore.vaultLedgerBlockPage(), [cursor, checkpointBlock]);
  assert.deepEqual(await restore.runtimeControl(), await store.runtimeControl(), "Runtime pause and CAS revision survive an isolated restore");
  const historicalBackup: Record<string, unknown> = { ...backup, version: 1 };
  for (const field of ["buyback_batches", "runtime_controls", "vault_ledger_state", "vault_ledger_blocks", "vault_ledger_events"]) delete historicalBackup[field];
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
          "version-3 backup preserves canonical vault journal, checkpoint, legacy balances and runtime control revision",
          "unknown Base source submission nonce, original hash, gas and replacement evidence survive backup restore",
          "source batch keyset pages preserve independent historical rows",
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
      "vault_ledger_events",
      "vault_ledger_blocks",
      "vault_ledger_state",
      "runtime_controls",
    ])
      await db.request(`musegod_${table}?scope=eq.${db.scope}`, "DELETE");
  }
}
