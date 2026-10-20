import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SupabaseStore } from "../server/supabase-store";
import { loadEnvironment } from "../server/config";
import { STOCKS, type TokenRecord } from "../src/lib/config";
import { TokenUniqueConflict, type LaunchPlan, type TokenUniqueKind } from "../server/store";
import { FEE_POLICY } from "../src/lib/fee-policy";
import type { PostKeyRecord, PostRecord } from "../server/post-store";
import { BASE_BUYBACK_PROTOCOL, BASE_BUYBACK_VAULT, BASE_BUYBACK_RH_WETH, BASE_BUYBACK_WETH, type BaseFeeBatch } from "../src/lib/base-buyback";
/** Disposable scopes only; the legacy probes use invalid commits and cannot mutate financial rows. */
export async function assertNativeAuditDatabaseMigration(store: SupabaseStore, url: string, key: string) {
  if (!/^verify-[a-z0-9-]+$/.test(store.scope)) throw new Error("Audit migration verification requires an isolated verify scope");
  const row = { id: `internal_native_migration_probe:${randomUUID()}`, protocol: "internal_native_migration_probe_v1", through: "0" };
  assert.equal(await store.compareAndSetBuybackAudit(row, null), true, "Native audit CAS RPC is absent or cannot commit");
  assert.equal(await store.compareAndSetBuybackAudit(row, null), false, "Native audit CAS must reject a stale expectation");
  await store.request(`musegod_buyback_batches?scope=eq.${store.scope}&id=eq.${encodeURIComponent(row.id)}`, "DELETE");
  for (const kind of ["vault", "custody"]) {
    const response = await fetch(`${url}/rest/v1/rpc/musegod_commit_${kind}_ledger_unbounded`, { method: "POST", redirect: "manual",
      headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify({ p_scope: store.scope, p_commit: {} }), signal: AbortSignal.timeout(15000) });
    const error = await response.json().catch(() => null);
    if (response.status !== 404 || error?.code !== "PGRST202")
      throw new Error("Legacy unbounded ledger RPC remains exposed or its absence could not be verified");
  }
}

/** All mutations stay inside a disposable verification scope; no live token, credential or shared upload budget is touched. */
export async function assertTokenPostsDatabaseMigration(store: SupabaseStore) {
  if (!/^verify-[a-z0-9-]+$/.test(store.scope)) throw new Error("Posts verification requires an isolated verify scope");
  const now = Date.now(), token = "0x0000000000000000000000000000000000000099", id = randomUUID();
  const key: PostKeyRecord = { id, token, issuer: token, name: "Database fixture", hash: "a".repeat(64), prefix: "fixture", createdAt: now, expiresAt: now + 86_400_000, revokedAt: null };
  assert.equal((await store.postAction({ action: "keyCreate", row: key })).key?.id, id);
  assert.equal((await store.postAction({ action: "keyCreate", row: key })).error?.code, "POST_KEY_EXISTS");
  const post: PostRecord = { id: randomUUID(), token, keyId: id, text: "Database fixture", imageIds: [], images: [], videoUrl: null, createdAt: now, deletedAt: null };
  const command = { action: "postCreate" as const, token, keyId: id, post, idempotencyKey: randomUUID(), requestHash: "b".repeat(64), now };
  const saved = await Promise.all([store.postAction(command), store.postAction(command)]);
  assert.equal(saved.filter(result => result.duplicate).length, 1, "Concurrent post retries insert exactly once");
  assert.equal((await store.postAction({ ...command, requestHash: "c".repeat(64) })).error?.status, 409);
  await store.postAction({ action: "postDelete", token, postId: post.id, now });
  assert.equal((await store.postAction(command)).post?.deletedAt, now, "A deleted post is never recreated by retry");
  await store.postAction({ action: "keyRevoke", token, id, now });
  assert.equal((await store.postAction(command)).error?.status, 401, "Idempotency cannot bypass revocation");
  return { token, keyId: id, postId: post.id };
}

export async function runDatabaseVerification() {
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
let connected = false, verificationFailed = false;
try {
  await store.health();
  await store.request(`musegod_buyback_batches?scope=eq.${scope}&select=sequence&limit=0`);
  connected = true;
  await assertNativeAuditDatabaseMigration(store, process.env.SUPABASE_URL || "", process.env.SUPABASE_SECRET_KEY || "");
  const postsFixture = await assertTokenPostsDatabaseMigration(store);
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
  // NFT re-verification settles only an open status (unverified or absent) and never touches a record without `nft`.
  const nft = { chainId: 4663 as const, contract: STOCKS[7].address, tokenId: "1" };
  const nftCoin = (n: number, over: Partial<TokenRecord>): TokenRecord =>
    ({ ...token, address: STOCKS[n].address, transactionHash: `0x${String(n + 3).repeat(64)}`, nft, ...over });
  const unverified = nftCoin(4, { nftVerification: { status: "unverified", reason: "rpc" } });
  await store.saveToken(unverified);
  await store.updateNftVerification({ ...unverified, nftVerification: { status: "verified", block: "1" } });
  assert.equal((await connect(scope).token(unverified.address))?.nftVerification?.status, "verified", "An unverified NFT status is settled in place");
  await store.updateNftVerification({ ...unverified, nftVerification: { status: "rejected", reason: "not_controller" } });
  assert.equal((await connect(scope).token(unverified.address))?.nftVerification?.status, "verified", "A settled NFT status is final");
  const absent = nftCoin(5, {});
  await store.saveToken(absent);
  await store.updateNftVerification({ ...absent, nftVerification: { status: "rejected", reason: "already_launched" } });
  assert.equal((await connect(scope).token(absent.address))?.nftVerification?.reason, "already_launched", "An NFT record with no status counts as unverified");
  const plain: TokenRecord = { ...token, address: STOCKS[6].address, transactionHash: `0x${"9".repeat(64)}` };
  await store.saveToken(plain);
  await store.updateNftVerification({ ...plain, nft, nftVerification: { status: "verified" } });
  assert.deepEqual(await connect(scope).token(plain.address), plain, "A record without nft is never touched");
  const proven: TokenRecord = { ...token, address: STOCKS[8].address, transactionHash: `0x${"a".repeat(64)}`, nft: { ...nft, tokenId: "2" },
    nftVerification: { status: "unverified", reason: "rpc" } };
  await store.saveToken(proven);
  await store.updateNftVerification({ ...proven, openingValuationUnverified: true, nftVerification: { status: "verified" } });
  assert.deepEqual(await connect(scope).token(proven.address), proven, "A write from an unproven read never downgrades a proven record");
  const launchFee = { asset: "stable" as const, txHash: `0x${"cd".repeat(32)}` as const };
  const payerCoin = (n: number, letter: string, fee: TokenRecord["launchFee"] = launchFee): TokenRecord =>
    ({ ...token, address: STOCKS[n].address, transactionHash: `0x${letter.repeat(64)}`, launchFee: fee });
  await store.saveToken(payerCoin(9, "b"));
  assert.equal(await connect(scope).tokenUsingLaunchFee(launchFee.txHash, token.creator!, STOCKS[9].address), null, "A coin's own fee is not another use");
  assert.equal((await connect(scope).tokenUsingLaunchFee(launchFee.txHash, token.creator!, STOCKS[10].address))?.address, STOCKS[9].address,
    "The holder of the fee is found for any other coin");
  // Migration 20261014120000: both guard indexes exist (a refusal names them) and refuse a duplicate, from any connection, and the readiness
  // check the runtime and nft:reverify depend on reports them.
  assert.equal(await connect(scope).nftGuardsReady(), true, "musegod_nft_guards_ready() reports both guard indexes and the launch claim");
  // The same migration's pre-sign launch claim: granted when free, refused to another owner while live, freed by release.
  const claimOwners = [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`], claims = [`nft:4663:${nft.contract.toLowerCase()}:1`, `fee:0x${"cd".repeat(32)}`];
  assert.deepEqual(await connect(scope).claimLaunch(claimOwners[0], claims, Date.now() + 60_000), [], "A free launch claim is granted");
  assert.deepEqual(await connect(scope).claimLaunch(claimOwners[1], [claims[1]], Date.now() + 60_000), [claims[1]], "A live launch claim is refused to another owner");
  await store.releaseLaunchClaims(claimOwners[0]);
  assert.deepEqual(await connect(scope).claimLaunch(claimOwners[1], claims, Date.now() + 60_000), [], "A released launch claim is free");
  await store.releaseLaunchClaims(claimOwners[1]);
  const refused = (kind: TokenUniqueKind) => (error: unknown) => error instanceof TokenUniqueConflict && error.kind === kind;
  await assert.rejects(() => connect(scope).saveToken(payerCoin(10, "c", { ...launchFee, txHash: `0x${"CD".repeat(32)}` as `0x${string}` })), refused("launch_fee"),
    "The launch-fee index refuses a second coin spending one payment, in any case");
  assert.equal(await connect(scope).token(STOCKS[10].address), null, "The refused coin was not written");
  await assert.rejects(() => store.saveToken(nftCoin(10, { transactionHash: `0x${"d".repeat(64)}`, nft: { ...nft, contract: nft.contract.toLowerCase() as `0x${string}` }, nftVerification: { status: "verified" } })),
    refused("nft_verified"), "The verified-NFT index refuses a second verified coin for one NFT, whatever the contract's case");
  const second = nftCoin(11, { transactionHash: `0x${"e".repeat(64)}`, nftVerification: { status: "unverified", reason: "rpc" } });
  await store.saveToken(second);
  await assert.rejects(() => connect(scope).updateNftVerification({ ...second, nftVerification: { status: "verified" } }), refused("nft_verified"),
    "The verified-NFT index refuses the compare-and-swap of a second verified coin");
  assert.equal((await connect(scope).token(second.address))?.nftVerification?.status, "unverified", "The refused compare-and-swap changed nothing");
  await store.saveToken(nftCoin(12, { transactionHash: `0x${"f".repeat(64)}`, nftVerification: { status: "rejected", reason: "already_launched" } }));
  assert.equal((await connect(scope).token(STOCKS[12].address))?.nftVerification?.reason, "already_launched", "Rejected and unverified coins for the NFT are allowed");
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
  await store.updateRuntimeControl(true, "Isolated database verification fixture", 0);
  const backup = await store.backup();
  assert.equal(backup.version, 3);
  await restore.restore(backup);
  assert.deepEqual((await restore.snapshot("fixture"))?.data, data);
  assert.deepEqual(await restore.token(token.address), token);
  assert.deepEqual(await restore.pendingLaunches(), queue);
  assert.deepEqual(await restore.getBuybackBatch(batch.id), confirmedBatch);
  assert.deepEqual(await restore.getBuybackBatch(sourceBatch.id), sourceBatch, "Source unknown/reserved submissions cannot lose their original broadcast evidence during restore");
  assert.deepEqual(await restore.runtimeControl(), await store.runtimeControl(), "Runtime pause and CAS revision survive an isolated restore");
  assert.notEqual((await restore.postAction({ action: "keyGet", token: postsFixture.token, id: postsFixture.keyId })).key?.revokedAt, null, "Restored post API keys never regain bearer authority");
  assert.equal((await restore.postAction({ action: "postsList", token: postsFixture.token, limit: 20 })).posts?.length, 0, "Deleted post tombstones survive restore");
  const historicalBackup: Record<string, unknown> = { ...backup, version: 1 };
  for (const field of ["buyback_batches", "runtime_controls", "vault_ledger_state", "vault_ledger_blocks", "vault_ledger_events",
    "custody_ledger_state", "custody_ledger_blocks", "custody_ledger_events", "post_api_keys", "posts", "post_media", "post_rates"]) delete historicalBackup[field];
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
          "native internal-audit CAS RPC exists and rejects stale expectations",
          "legacy unbounded ledger RPCs are absent from the server Data API",
          "atomic concurrent quota",
          "quota survives reconnect",
          "snapshot readback",
          "consistent backup / empty target restore",
          "restore preserves quota",
          "nonempty restore rejected",
          "launch plan and pending hash survive reconnect",
          "fee policy and original treasury survive reconnect and backup restore",
          "idempotent token registration and replacement status",
          "NFT verification compare-and-swap settles only unverified or absent statuses and never touches non-NFT records",
          "NFT verification compare-and-swap matches the provenance it read and never downgrades it",
          "launch-fee single use excludes only the coin itself",
          "musegod_nft_guards_ready() reports both NFT single-use guard indexes and the launch claim",
          "the pre-sign launch claim is granted when free, refused to another owner while live and freed by release",
          "the launch-fee guard index refuses a second coin spending one payment, in any case",
          "the verified-NFT guard index refuses a second verified coin (insert or compare-and-swap) and allows rejected and unverified ones",
          "backup restores token and canonical receipt identity",
          "orphan token removal",
          "buyback batch amounts and receipt history survive reconnect and upsert",
          "buyback batch scope isolation and 24-hour cleanup retention",
          "version-3 backup preserves runtime control revision and transaction history",
          "legacy ledger data is preserved by the unchanged database backup / restore functions",
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
} catch (error) {
  verificationFailed = true;
  throw error;
} finally {
  let cleanupError: unknown;
  for (const db of connected ? [store, restore, legacy, occupied] : []) {
    assert(/^(verify|restore)-/.test(db.scope));
    for (const table of [
      "pending_launches",
      "tokens",
      "plans",
      "snapshots",
      "quota",
      "buyback_batches",
      "runtime_controls",
      "launch_claims",
      "post_api_keys",
      "posts",
      "post_media",
      "post_rates",
    ]) {
      try { await db.request(`musegod_${table}?scope=eq.${db.scope}`, "DELETE"); }
      catch (error) {
        if (table === "launch_claims" && error instanceof Error &&
          error.message === "Database request failed (404). Check the server configuration and migrations.") continue;
        cleanupError ??= error;
      }
    }
  }
  if (cleanupError) {
    if (!verificationFailed) throw cleanupError;
    console.error("Verify-scope cleanup failed:", cleanupError);
  }
}
}
const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
const runner = process.argv[2] && pathToFileURL(resolve(process.argv[2])).href === import.meta.url && process.argv[1]?.endsWith("run.ts");
if (direct || runner) await runDatabaseVerification();
