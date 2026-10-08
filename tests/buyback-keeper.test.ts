import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, type Address, type Hex } from "viem";
import { acquireKeeperJournalLock, assertKeeperAccount, assertKeeperDeploymentAccount, assertKeeperGraph, assertKeeperSubmissionRuntime, assertKeeperNonceReady, keeperApiOrigin, keeperGasCost, keeperProfitThreshold, keeperSyncHasNewCredit, keeperTaskWait, KEEPER_TASK_RETRY_POLICY, KeeperSigningStopped, KeeperSubmissionBarrier, readKeeperJournal, readKeeperTaskState, reconcileKeeperJournal, recordKeeperTaskOutcome, redactKeeperError, selectKeeperTasks, writeKeeperJournal, writeKeeperTaskState, type KeeperJournal, type KeeperTaskStateFile } from "../scripts/buyback-keeper";
import { BUYBACK_WETH, BUYBACK_FORWARDER_ALLOWANCE_CAP, buybackAmountCandidates, type BuybackEngineStatus, type EngineAssetStatus } from "../src/lib/buyback-engine";
import { MUSEGOD_BUYBACK } from "../src/lib/fee-policy";
import { ENGINE_FEE_POLICY } from "../src/lib/fee-policy";
import type { RuntimeConfig } from "../src/lib/config";
import type { BuybackDeployment } from "../server/buyback-engine";
import deployment from "../contracts/artifacts/buyback-v2-deployment.json";
import { redact } from "../server/config";
import buybackConfig from "../contracts/buyback.config.json";

const stock = "0x1111111111111111111111111111111111111111" as Address;
const unknown = "0x2222222222222222222222222222222222222222" as Address;
const vault = "0x9999999999999999999999999999999999999999" as Address;
const assetOracle = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const poolId = `0x${"aa".repeat(32)}` as Hex;
const asset = (address: Address, changes: Partial<EngineAssetStatus> = {}): EngineAssetStatus => ({ address, symbol: "TEST", decimals: 18, pending: "100", claimed: "100", converted: "0", forwarded: "0", automationForwarded: "0", pricing: "supported", available: "10", referenceWeth: "20", error: null, ...changes });
const status = (changes: Partial<BuybackEngineStatus> = {}): BuybackEngineStatus => ({ available: true, reason: null, blockNumber: "100", engine: stock, swapper: stock, executor: stock, operationsTreasury: stock, automationReceiver: unknown, automationTreasury: deployment.constants.automationTreasury as Address, wethForwarder: "0x7777777777777777777777777777777777777777", sourceDeployed: true, sourceWeth: "0", sourceAllowance: "1", sourceForwarded: "0", sourceAvailable: "0", assets: [], pools: [], swapperWeth: "0", vault, assetOracle, vaultWeth: "0", vaultAvailable: "0", directBurned: "0", convertedWeth: "0", burns: [], burnScanFrom: "90", ...changes });

test("keeper origins reject non-HTTPS hosts, redirects via paths and embedded credentials", () => {
  assert.equal(keeperApiOrigin("https://musegod.fun"), "https://musegod.fun");
  assert.equal(keeperApiOrigin("http://127.0.0.1:5188"), "http://127.0.0.1:5188");
  assert.equal(keeperApiOrigin("http://[::1]:5188/"), "http://[::1]:5188");
  for (const bad of ["http://musegod.fun", "http://localhost.evil", "https://user:secret@musegod.fun", "https://musegod.fun/api", "https://musegod.fun?rpc=evil", "https://musegod.fun#secret", "ftp://127.0.0.1"])
    assert.throws(() => keeperApiOrigin(bad));
});

test("keeper gas profitability stays in raw units and rounds the 20 percent buffer upward", () => {
  assert.equal(keeperGasCost(100n, 7n), 700n);
  assert.equal(keeperProfitThreshold(700n), 840n);
  assert.equal(keeperProfitThreshold(1n), 2n);
  assert.equal(keeperProfitThreshold(11n), 14n);
  assert.equal(keeperProfitThreshold(10n ** 30n), 12n * 10n ** 29n);
  assert.throws(() => keeperGasCost(0n, 1n));
  assert.throws(() => keeperGasCost(1n, 0n));
  assert.throws(() => keeperProfitThreshold(0n));
});

test("keeper selection isolates unsupported assets, respects window budgets and burns MUSEGOD directly", () => {
  const tasks = selectKeeperTasks(status({ assets: [asset(BUYBACK_WETH), asset(stock), asset(unknown, { referenceWeth: null, error: "No feed" }), asset(MUSEGOD_BUYBACK.tokenAddress, { available: "0", referenceWeth: null }), asset(stock, { available: "0" })], vaultAvailable: "20" }), 1_000_000);
  assert.deepEqual(tasks.map((task) => task.id), [`forward:${BUYBACK_WETH}`, `convert:${stock}`, `burn:${MUSEGOD_BUYBACK.tokenAddress}`, "execute:weth"]);
  const conversion = tasks[1]; assert("kind" in conversion); assert.equal(conversion.amount, "10");
  const burn = tasks[2]; assert("action" in burn); assert.deepEqual(burn.action, { kind: "burn", amount: "100" });
  const execute = tasks[3]; assert("action" in execute); assert.deepEqual(execute.action, { kind: "execute", amount: "20", minProfit: "1", deadline: 1060 });
  assert.deepEqual(selectKeeperTasks(status({ available: false, assets: [asset(stock)] })), []);
});

test("keeper releases the full credited unpriced balance while stale, paused and unknown classifications remain pending", () => {
  const unpriced = asset(unknown, { pricing: "unsupported_static", pending: "100", available: "0", referenceWeth: null, error: null });
  const tasks = selectKeeperTasks(status({ assets: [unpriced, asset(stock, { pricing: "supported", referenceWeth: null, error: "StaleFeed" }), asset(stock, { pricing: "supported", referenceWeth: null, error: "OraclePaused" }), asset(stock, { pricing: "unknown", available: "0", referenceWeth: null, error: "Classification read failed" })] }));
  assert.equal(tasks.length, 1);
  assert("action" in tasks[0]);
  assert.deepEqual(tasks[0].action, { kind: "release_unpriced", token: unknown, amount: "100" });
  assert.equal(tasks[0].id, `release:${unknown}`);
  const malformedSpecial = selectKeeperTasks(status({ assets: [asset(BUYBACK_WETH, { pricing: "unsupported_static", referenceWeth: null, available: "0" })] }));
  assert.equal(malformedSpecial.length, 0, "WETH must never use the unpriced Automation path");
  assert.match(tasks[0].label, /Splits Automation/);
});

test("keeper binds the independent Automation receiver and operating treasury without allowing either account to sign", () => {
  const engine = "0x3333333333333333333333333333333333333333" as Address;
  const executor = "0x4444444444444444444444444444444444444444" as Address;
  const ops = deployment.constants.treasury as Address;
  const source = deployment.constants.automationTreasury as Address;
  const forwarder = "0x7777777777777777777777777777777777777777" as Address;
  // Explicitly configured mock metadata does not prove a native rule was saved or run.
  const manifest: BuybackDeployment = { ...deployment, status: "deployed_verified",
    contracts: { vault: { address: vault, runtimeHash: null }, assetOracle: { address: assetOracle, runtimeHash: null }, oracle: { address: "0x5555555555555555555555555555555555555555", runtimeHash: null }, engine: { address: engine, runtimeHash: null }, swapper: { address: stock, runtimeHash: null }, executor: { address: executor, runtimeHash: null }, forwarder: { address: forwarder, runtimeHash: null } },
    constants: { ...deployment.constants, automation: unknown },
    automation: { status: "configured", account: unknown, network: 4663, outputToken: BUYBACK_WETH, allocationBps: 10_000, recipient: source },
  };
  const config: RuntimeConfig = { mode: "robinhood", deploymentChainId: 4663, chainId: 4663, treasury: ops, writesEnabled: true, blockReason: null, feePolicy: ENGINE_FEE_POLICY, feeEngine: engine, buybackExecutor: executor, automationReceiver: unknown, automationTreasury: source, wethForwarder: forwarder, buybackVault: vault, assetFeedOracle: assetOracle };
  const current = status({ engine, executor, operationsTreasury: ops, automationReceiver: unknown });
  assert.doesNotThrow(() => assertKeeperGraph(config, current, manifest));
  const paused = { ...config, writesEnabled: false, signingPaused: true };
  assert.doesNotThrow(() => assertKeeperSubmissionRuntime(paused, config, current, manifest), "user issuance pause does not disable an explicitly authorized, verified keeper");
  assert.throws(() => assertKeeperSubmissionRuntime(paused, { ...config, chainId: 31337, mode: "fork" }, current, manifest), /network changed/);
  assert.throws(() => assertKeeperSubmissionRuntime({ ...paused, feeEngine: null }, config, current, manifest), /reviewed deployment/);
  assert.throws(() => assertKeeperSubmissionRuntime(paused, config, { ...current, available: false }, manifest), /reviewed deployment/);

  assert.doesNotThrow(() => assertKeeperGraph(config, { ...current, sourceAllowance: "0" }, manifest), "Exhausted finite source approval must not stop existing Vault funds");
  for (const receiver of [null, ops, stock]) {
    assert.throws(() => assertKeeperGraph({ ...config, automationReceiver: receiver }, current, manifest), /reviewed deployment/);
    assert.throws(() => assertKeeperGraph(config, { ...current, automationReceiver: receiver }, manifest), /reviewed deployment/);
  }
  assert.throws(() => assertKeeperGraph({ ...config, treasury: unknown }, current, manifest), /reviewed deployment/);
  assert.throws(() => assertKeeperGraph(config, { ...current, operationsTreasury: unknown }, manifest), /reviewed deployment/);
  for (const changes of [{ automationTreasury: null }, { automationTreasury: ops }, { wethForwarder: null }, { wethForwarder: executor }]) {
    assert.throws(() => assertKeeperGraph({ ...config, ...changes }, current, manifest), /reviewed deployment/);
    assert.throws(() => assertKeeperGraph(config, { ...current, ...changes }, manifest), /reviewed deployment/);
  }
  for (const changes of [{ sourceDeployed: false }, { sourceAllowance: null }])
    assert.throws(() => assertKeeperGraph(config, { ...current, ...changes }, manifest), /reviewed deployment/);
  assert.doesNotThrow(() => assertKeeperGraph(config, { ...current, sourceAllowance: String(BUYBACK_FORWARDER_ALLOWANCE_CAP + 1n) }, manifest), "Excess source approval isolates forwarding without blocking Vault processing");
  for (const changes of [{ status: "not_configured" }, { account: null }, { account: ops }, { network: 31337 }, { outputToken: stock }, { allocationBps: 8000 }, { recipient: executor }])
    assert.throws(() => assertKeeperGraph(config, current, { ...manifest, automation: { ...manifest.automation!, ...changes } }), /reviewed deployment/);
  assert.throws(() => assertKeeperGraph(config, current, { ...manifest, automation: undefined }), /reviewed deployment/);
  assert.throws(() => assertKeeperAccount(ops, config), /operations treasury, Splits Automation/);
  assert.throws(() => assertKeeperAccount(unknown, config), /operations treasury, Splits Automation/);
  assert.throws(() => assertKeeperAccount(source, config), /source treasury account/);
  assert.doesNotThrow(() => assertKeeperAccount(stock, config));
});

test("keeper forwards authorized source WETH before settlement without using Oracle prices or engine windows", () => {
  for (const [balance, allowance, amount] of [[100n, 25n, 25n], [10n, 25n, 10n]] as const) {
    const tasks = selectKeeperTasks(status({ sourceWeth: String(balance), sourceAllowance: String(allowance), sourceAvailable: String(amount), vaultAvailable: "1" }));
    assert.deepEqual(tasks.map((task) => task.id), ["forward:source", "execute:weth"]);
    assert("action" in tasks[0]); assert.deepEqual(tasks[0].action, { kind: "forward_source", amount: String(amount) });
    assert.match(tasks[0].label, /no caller reward/);
  }
  for (const changes of [{ sourceDeployed: false }, { sourceWeth: "0" }, { sourceAllowance: String(2n ** 256n - 1n) }, { sourceAllowance: String(2n ** 256n - 2n) }, { sourceAllowance: String(BUYBACK_FORWARDER_ALLOWANCE_CAP + 1n) }, { sourceAllowance: null }])
    assert.equal(selectKeeperTasks(status({ sourceWeth: "100", sourceAllowance: "25", ...changes })).length, 0);
  assert.deepEqual(selectKeeperTasks(status({ sourceWeth: "100", sourceAllowance: String(BUYBACK_FORWARDER_ALLOWANCE_CAP + 1n), vaultAvailable: "1" })).map((task) => task.id), ["execute:weth"], "An oversized source approval isolates forwarding and leaves existing Vault funds executable");
});

test("keeper collection uses only positive known LP or hook previews and deduplicates pools", () => {
  const pool = { address: stock, symbol: "TEST", poolId, claimable: [{ address: stock, symbol: "TEST", decimals: 18, lp: null, hook: "2" }] };
  const tasks = selectKeeperTasks(status({ pools: [pool, pool, { ...pool, poolId: `0x${"bb".repeat(32)}`, claimable: null }, { ...pool, poolId: `0x${"cc".repeat(32)}`, claimable: [{ ...pool.claimable[0], lp: "0", hook: "0" }] }] }));
  assert.equal(tasks.length, 1);
  assert("action" in tasks[0]);
  assert.deepEqual(tasks[0].action, { kind: "claim", poolId });
});

test("syncs associate positive untracked balances with verified pool currencies and deduplicate shared assets", () => {
  const otherPool = `0x${"bb".repeat(32)}` as Hex, thirdPool = `0x${"cc".repeat(32)}` as Hex;
  const pool = { address: stock, symbol: "TEST", poolId, claimable: null, currencies: [stock, BUYBACK_WETH] };
  const pools = [pool, { ...pool, poolId: otherPool, currencies: [stock, unknown] }, { ...pool, poolId: thirdPool, currencies: [unknown, BUYBACK_WETH] }];
  const untracked = (address: Address) => asset(address, { pending: "0", available: "0", untracked: "1" });
  assert.deepEqual(selectKeeperTasks(status({ pools, assets: [untracked(MUSEGOD_BUYBACK.tokenAddress)] })), [], "An unrelated one-wei donation must not fan out to every pool");
  assert.deepEqual(selectKeeperTasks(status({ pools, assets: [untracked(stock)] })).map((task) => task.id), [`sync:${poolId}`]);
  assert.deepEqual(selectKeeperTasks(status({ pools, assets: [untracked(stock), untracked(unknown)] })).map((task) => task.id), [`sync:${poolId}`, `sync:${otherPool}`]);
  assert.deepEqual(selectKeeperTasks(status({ pools: [{ ...pool, currencies: null }], assets: [untracked(stock)] })), [], "Unknown or legacy pool keys cannot authorize a guessed sync");
});

test("sync rechecks canonical keys, shares and actual same-block balance deltas before submission", async () => {
  const initializer = getAddress(buybackConfig.constants.initializer), rehype = getAddress(buybackConfig.constants.rehype);
  const currencies = [stock, BUYBACK_WETH].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1) as [Address, Address];
  const key = { currency0: currencies[0], currency1: currencies[1], fee: 0x800000, tickSpacing: 10, hooks: initializer };
  const id = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  let balance = 11n, assetReads = 0;
  const client = { getBlockNumber: async () => 77n, readContract: async ({ address, functionName, args, blockNumber }: { address: Address; functionName: string; args: unknown[]; blockNumber: bigint }) => {
    assert.equal(blockNumber, 77n);
    if (functionName === "getPoolKey") { assert.equal(args[0], id); if (address === rehype) throw new Error("One manager is temporarily unavailable"); return key; }
    if (functionName === "getShares") return 228n * 10n ** 15n;
    assetReads++;
    if (functionName === "balanceOf") return address === stock ? balance : 0n;
    assert.equal(functionName, "pending"); return args[0] === stock ? 10n : 0n;
  } } as unknown as Parameters<typeof keeperSyncHasNewCredit>[0];
  assert.equal(await keeperSyncHasNewCredit(client, vault, id), true);
  balance = 10n;
  assert.equal(await keeperSyncHasNewCredit(client, vault, id), false, "An earlier successful sync makes the queued task a no-op");
  assert.equal(assetReads, 8);
  const invalid = { ...client, readContract: async (input: Parameters<typeof client.readContract>[0]) => {
    if (input.functionName === "getPoolKey") return { ...key, tickSpacing: 1 };
    return client.readContract(input);
  } } as unknown as Parameters<typeof keeperSyncHasNewCredit>[0];
  assert.equal(await keeperSyncHasNewCredit(invalid, vault, id), false);
  assert.equal(assetReads, 8, "An invalid pool must never select arbitrary token balance reads");
});

test("keeper errors cannot expose dedicated signing keys or upstream URLs", () => {
  const key = `0x${"ab".repeat(32)}`;
  const message = redactKeeperError(new Error(`Signing failed for ${key} via https://rpc.example/v2/private-key`), [key]);
  assert(!message.includes(key)); assert(!message.includes("private-key")); assert(!message.includes("https://"));
  assert(message.includes("[redacted]")); assert(message.includes("[upstream]"));
  assert(!redactKeeperError(new Error(key.toUpperCase()), [key]).includes(key.toUpperCase()));
});

test("deployment signer aliases are compared by public address and server errors redact EVM_DY", () => {
  const key = `${"0".repeat(63)}1`, caller = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as Address;
  for (const raw of [key, `0x${key}`, `  0X${key}  `])
    assert.throws(() => assertKeeperDeploymentAccount(caller, [undefined, raw]), /must not reuse a deployment account/);
  assert.doesNotThrow(() => assertKeeperDeploymentAccount(stock, [key]));
  const previous = process.env.EVM_DY;
  try {
    process.env.EVM_DY = ` ${key} `;
    const message = redact(new Error(`Signer 0x${key.toUpperCase()} failed`));
    assert(!message.includes(key)); assert(message.includes("[redacted]"));
  } finally {
    if (previous === undefined) delete process.env.EVM_DY; else process.env.EVM_DY = previous;
  }
});

test("keeper never queues a second task behind an unresolved dedicated-wallet transaction", () => {
  assert.doesNotThrow(() => assertKeeperNonceReady(10, 10));
  assert.throws(() => assertKeeperNonceReady(10, 11), /pending transaction/);
  assert.throws(() => assertKeeperNonceReady(10, 9), /pending transaction/);
  assert.throws(() => assertKeeperNonceReady(-1, -1), /pending transaction/);
});

test("the real once CLI stays read-only by default even when a dedicated key is configured", async () => {
  const requests: { method: string | undefined; path: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/config") res.end(JSON.stringify({ mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null }));
    else if (req.url === "/api/buyback/engine") res.end(JSON.stringify(status({ available: false, reason: "Awaiting verified deployment" })));
    else { res.statusCode = 400; res.end(JSON.stringify({ error: "Unexpected request" })); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/buyback-keeper.ts", "--once", `--api=http://127.0.0.1:${port}`], {
      env: { ...process.env, MUSEGOD_KEEPER_PRIVATE_KEY: `0x${"1".repeat(64)}`, MUSEGOD_DEPLOY_PRIVATE_KEY: "", EVM_DY: "", ALCHEMY_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", errors = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { errors += String(chunk); });
    const exit = await new Promise<number | null>((done) => child.once("exit", done));
    assert.equal(exit, 0, errors);
    assert.match(output, /"mode":"dry_run"/);
    assert.match(output, /"state":"waiting"/);
    assert(!output.includes(`0x${"1".repeat(64)}`));
    assert.deepEqual(requests.sort((a, b) => a.path!.localeCompare(b.path!)), [{ method: "GET", path: "/api/buyback/engine" }, { method: "GET", path: "/api/config" }]);
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
});

test("buyback candidate sizes halve at most twenty times and cap even enormous balances at 0.01 WETH", () => {
  assert.deepEqual(buybackAmountCandidates(64n), [64n, 32n, 16n, 8n, 4n, 2n, 1n]);
  assert.deepEqual(buybackAmountCandidates(3n), [3n, 1n]);
  assert.deepEqual(buybackAmountCandidates(1n), [1n]);
  assert.deepEqual(buybackAmountCandidates(0n), []);
  assert.deepEqual(buybackAmountCandidates(-1n), []);
  const huge = buybackAmountCandidates(10n ** 30n);
  assert.equal(huge.length, 20);
  assert.equal(huge[0], 10n ** 16n);
  assert(huge.every((value) => value > 0n && value <= 10n ** 16n));
});

const transactionInput = "0x11223344" as Hex;
const signedTransaction = "0x123456" as Hex;
const journalInput = { chainId: 4663, caller: stock, nonce: 8, taskId: "execute:weth", to: unknown, dataHash: keccak256(transactionInput), value: "0" as const, gasLimit: "100000", gasPrice: "7" };
const canonicalHash = `0x${"ab".repeat(32)}` as Hex;
function recoveryDeps(journal: KeeperJournal, persist: (value: KeeperJournal) => Promise<void>, changes: Partial<Parameters<typeof reconcileKeeperJournal>[1]> = {}): Parameters<typeof reconcileKeeperJournal>[1] {
  return {
    receipt: async (hash) => ({ status: "success", transactionHash: hash, from: stock, to: unknown, blockNumber: 10n, blockHash: canonicalHash }),
    transaction: async (hash) => ({ hash, from: stock, to: unknown, nonce: journal.nonce, input: transactionInput, value: 0n }),
    head: async () => 11n, block: async () => ({ hash: canonicalHash }), persist, ...changes,
  };
}

test("a lost broadcast response retains an atomic journal and stops every later signature even after nonce advances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeper-journal-"));
  const path = join(directory, "4663-caller.json");
  const barrier = new KeeperSubmissionBarrier();
  let signs = 0, broadcasts = 0;
  const persist = (journal: KeeperJournal) => writeKeeperJournal(path, journal);
  const deps = {
    sign: async () => { signs++; return signedTransaction; }, persist,
    broadcast: async () => {
      broadcasts++;
      const saved = await readKeeperJournal(path, 4663, stock);
      assert(saved, "Hash and nonce must exist on disk before contacting the RPC");
      assert.equal(saved.hash, keccak256(signedTransaction)); assert.equal(saved.nonce, 8); assert.equal(saved.status, "signed");
      throw new Error("Broadcast was mined but the response was lost");
    },
    confirm: async (journal: KeeperJournal) => journal,
  };
  try {
    await assert.rejects(() => barrier.submit(journalInput, deps), KeeperSigningStopped);
    const retained = await readKeeperJournal(path, 4663, stock);
    assert(retained);
    assert.equal(barrier.signingStopped, true);
    assert.doesNotThrow(() => assertKeeperNonceReady(9, 9), "The nonce gate alone would incorrectly permit another action");
    await assert.rejects(() => barrier.submit({ ...journalInput, nonce: 9, taskId: "forward:weth" }, deps), KeeperSigningStopped);
    assert.equal(signs, 1); assert.equal(broadcasts, 1);
    const disk = await readFile(path, "utf8");
    assert(!disk.includes(signedTransaction)); assert(!disk.includes("privateKey")); assert(!disk.includes("serializedTransaction"));
    const restarted = new KeeperSubmissionBarrier();
    await assert.rejects(async () => {
      await reconcileKeeperJournal(retained, recoveryDeps(retained, persist, { receipt: async () => { throw new Error("Receipt unavailable"); } }));
      await restarted.submit({ ...journalInput, nonce: 9 }, deps);
    }, KeeperSigningStopped);
    assert.equal(signs, 1, "Restart cannot sign before exact receipt reconciliation succeeds");
    const recovered = await reconcileKeeperJournal(retained, recoveryDeps(retained, persist));
    assert.equal(recovered.status, "confirmed");
    assert.equal((await readKeeperJournal(path, 4663, stock))!.status, "confirmed");
    assert.equal(broadcasts, 1, "Reconciliation reads and records the original receipt without replaying it");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("receipt timeout and journal persistence failure are fail-stop rather than task retries", async () => {
  for (const failure of ["receipt", "disk"]) {
    const barrier = new KeeperSubmissionBarrier();
    let signs = 0, broadcasts = 0;
    const deps = {
      sign: async () => { signs++; return signedTransaction; },
      persist: async () => { if (failure === "disk") throw new Error("Atomic write failed"); },
      broadcast: async () => { broadcasts++; return keccak256(signedTransaction); },
      confirm: async (): Promise<KeeperJournal> => { throw new Error("Receipt timed out"); },
    };
    await assert.rejects(() => barrier.submit(journalInput, deps), KeeperSigningStopped);
    await assert.rejects(() => barrier.submit({ ...journalInput, nonce: 9 }, deps), KeeperSigningStopped);
    assert.equal(signs, 1); assert.equal(broadcasts, failure === "disk" ? 0 : 1);
  }
});

test("journal recovery requires exact nonce, target, calldata and canonical two-confirmation proof", async () => {
  const journal: KeeperJournal = { ...journalInput, schemaVersion: 1, hash: keccak256(signedTransaction), signedAt: Date.now(), status: "signed" };
  for (const changes of [
    { head: async () => 10n }, { block: async () => ({ hash: `0x${"ff".repeat(32)}` as Hex }) },
    { transaction: async (hash: Hex) => ({ hash, from: stock, to: unknown, nonce: 9, input: transactionInput, value: 0n }) },
    { transaction: async (hash: Hex) => ({ hash, from: stock, to: stock, nonce: 8, input: transactionInput, value: 0n }) },
    { transaction: async (hash: Hex) => ({ hash, from: stock, to: unknown, nonce: 8, input: "0x99887766" as Hex, value: 0n }) },
  ]) {
    let writes = 0;
    await assert.rejects(() => reconcileKeeperJournal(journal, recoveryDeps(journal, async () => { writes++; }, changes)), KeeperSigningStopped);
    assert.equal(writes, 0);
  }
  let terminal: KeeperJournal | null = null;
  const reverted = await reconcileKeeperJournal(journal, recoveryDeps(journal, async (entry) => { terminal = entry; }, {
    receipt: async (hash) => ({ status: "reverted", transactionHash: hash, from: stock, to: unknown, blockNumber: 10n, blockHash: canonicalHash }),
  }));
  assert.equal(reverted.status, "reverted", "A canonical failure is resolved; only a newly simulated attempt may retry later");
  assert.equal((terminal as KeeperJournal | null)?.status, "reverted");
});

test("canonical revert cost and resolution time are recorded from the receipt rather than the gas limit", async () => {
  const journal: KeeperJournal = { ...journalInput, schemaVersion: 1, hash: keccak256(signedTransaction), signedAt: Date.now(), status: "broadcast" };
  const result = await reconcileKeeperJournal(journal, recoveryDeps(journal, async () => {}, {
    receipt: async (hash) => ({ status: "reverted", transactionHash: hash, from: stock, to: unknown, blockNumber: 10n, blockHash: canonicalHash, gasUsed: 50_000n, effectiveGasPrice: 7n }),
  }));
  assert.equal(result.gasSpent, "350000"); assert(result.resolvedAt! >= journal.signedAt);
  const reread = await reconcileKeeperJournal(result, recoveryDeps(result, async () => {}, {
    receipt: async (hash) => ({ status: "reverted", transactionHash: hash, from: stock, to: unknown, blockNumber: 10n, blockHash: canonicalHash, gasUsed: 50_000n, effectiveGasPrice: 7n }),
  }));
  assert.equal(reread.resolvedAt, result.resolvedAt, "Reading the same receipt cannot renew its backoff");
});

test("resolved reverts persist task-level backoff across restarts without delaying unrelated tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeper-task-budget-")), path = join(directory, "tasks.json");
  const at = 1_800_000_000_000;
  const journal: KeeperJournal = { ...journalInput, schemaVersion: 1, hash: keccak256(signedTransaction), signedAt: at, resolvedAt: at + 10_000, gasSpent: "100", status: "reverted" };
  try {
    const empty = await readKeeperTaskState(path, 4663, stock);
    const updated = recordKeeperTaskOutcome(empty, journal);
    assert.equal(updated.tasks[journal.taskId].consecutiveReverts, 1);
    assert.equal(updated.tasks[journal.taskId].nextAttemptAt, journal.resolvedAt! + KEEPER_TASK_RETRY_POLICY.initialBackoffMs);
    assert.equal(recordKeeperTaskOutcome(updated, journal), updated, "Repeated canonical reconciliation must not charge gas twice");
    await writeKeeperTaskState(path, updated);
    const restarted = await readKeeperTaskState(path, 4663, stock);
    assert(keeperTaskWait(restarted, journal.taskId, 0n, at + 20_000));
    assert.equal(keeperTaskWait(restarted, "forward:source", 0n, at + 20_000), null, "A failed settlement must not starve collection or forwarding");
    assert.equal(keeperTaskWait(restarted, journal.taskId, 0n, at + 130_000), null);
    await assert.rejects(() => readKeeperTaskState(path, 8453, stock), KeeperSigningStopped);
    await assert.rejects(() => readKeeperTaskState(path, 4663, unknown), KeeperSigningStopped);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("three canonical reverts impose a rolling hourly task limit even after a successful retry", () => {
  const at = 1_800_000_000_000;
  let state: KeeperTaskStateFile = { schemaVersion: 1, chainId: 4663, caller: stock, tasks: {} };
  const outcome = (index: number, status: "confirmed" | "reverted") => ({ ...journalInput, schemaVersion: 1 as const, hash: `0x${String(index).padStart(64, "0")}` as Hex, signedAt: at + index * 1000, resolvedAt: at + index * 1000, gasSpent: "1", status });
  for (let i = 1; i <= 3; i++) state = recordKeeperTaskOutcome(state, outcome(i, "reverted"));
  const waiting = keeperTaskWait(state, journalInput.taskId, 0n, at + 500_000);
  assert.match(waiting!.reason, /repeated canonical reverts/);
  state = recordKeeperTaskOutcome(state, outcome(4, "confirmed"));
  assert.equal(state.tasks[journalInput.taskId].consecutiveReverts, 0);
  assert(keeperTaskWait(state, journalInput.taskId, 0n, at + 500_000), "Success clears exponential backoff but cannot erase spent failure attempts");
  assert.equal(keeperTaskWait(state, journalInput.taskId, 0n, at + 3_604_000), null);
});

test("a canonical reorg outcome replaces the same hash failure rather than preserving or double-counting it", () => {
  const at = 1_800_000_000_000;
  const failed: KeeperJournal = { ...journalInput, schemaVersion: 1, hash: keccak256(signedTransaction), signedAt: at, resolvedAt: at, gasSpent: "100", blockHash: canonicalHash, status: "reverted" };
  let state = recordKeeperTaskOutcome({ schemaVersion: 1, chainId: 4663, caller: stock, tasks: {} }, failed);
  const reorg = { ...failed, resolvedAt: at + 1000, gasSpent: "90", blockHash: `0x${"ef".repeat(32)}` as Hex };
  state = recordKeeperTaskOutcome(state, reorg);
  assert.equal(state.tasks[failed.taskId].failures.length, 1);
  assert.equal(state.tasks[failed.taskId].failures[0].gasWei, "90");
  assert.equal(state.tasks[failed.taskId].consecutiveReverts, 1);
  state = recordKeeperTaskOutcome(state, { ...reorg, status: "confirmed" });
  assert.equal(state.tasks[failed.taskId].failures.length, 0);
  assert.equal(keeperTaskWait(state, failed.taskId, 0n, at + 1001), null);
});

test("the failed-gas budget blocks only once spent, separately from the single-attempt gas cap", () => {
  const at = 1_800_000_000_000, budget = KEEPER_TASK_RETRY_POLICY.maximumFailedGasWei;
  const empty: KeeperTaskStateFile = { schemaVersion: 1, chainId: 4663, caller: stock, tasks: {} };
  // 800k gas at 1-2 gwei with the 25% buffer: no failures means no failed-gas wait.
  for (const gasPrice of [10n ** 9n, 2n * 10n ** 9n])
    assert.equal(keeperTaskWait(empty, "execute:weth", keeperGasCost(1_000_000n, gasPrice), at), null);
  const capped = keeperTaskWait(empty, "execute:weth", KEEPER_TASK_RETRY_POLICY.maximumAttemptGasWei + 1n, at);
  assert.match(capped!.reason, /single-attempt cap/); assert.doesNotMatch(capped!.reason, /budget/);
  assert.equal(capped!.nextAttemptAt, at + KEEPER_TASK_RETRY_POLICY.gasRetryMs);
  const journal: KeeperJournal = { ...journalInput, schemaVersion: 1, hash: keccak256(signedTransaction), signedAt: at, resolvedAt: at, gasSpent: String(budget - 1n), status: "reverted" };
  const state = recordKeeperTaskOutcome(empty, journal);
  assert.equal(keeperTaskWait(state, journal.taskId, 2n * 10n ** 15n, at + 120_000), null, "an unspent budget does not reserve the next attempt");
  const spent = recordKeeperTaskOutcome(state, { ...journal, hash: keccak256(`${signedTransaction}00`), signedAt: at + 130_000, resolvedAt: at + 130_000, gasSpent: "1" });
  const blocked = keeperTaskWait(spent, journal.taskId, 1n, at + 3_700_000);
  assert.match(blocked!.reason, /failed-gas budget is used up/); assert.equal(blocked!.nextAttemptAt, at + 86_400_000);
  assert.equal(keeperTaskWait(spent, "forward:source", 1n, at + 3_700_000), null);
  assert.equal(keeperTaskWait(spent, journal.taskId, 1n, at + 3_700_000)!.nextAttemptAt, blocked!.nextAttemptAt, "Read retries must not renew the budget window");
  assert.equal(keeperTaskWait(spent, journal.taskId, 1n, at + 130_000 + 86_400_000 + 1), null);
});

test("damaged or private task-state fields fail-stop instead of silently resetting retry budgets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeper-task-damaged-")), path = join(directory, "tasks.json");
  try {
    const state: KeeperTaskStateFile = { schemaVersion: 1, chainId: 4663, caller: stock, tasks: {} };
    await assert.rejects(() => writeKeeperTaskState(path, { ...state, privateKey: "forbidden" } as KeeperTaskStateFile), KeeperSigningStopped);
    await writeFile(path, "damaged");
    await assert.rejects(() => readKeeperTaskState(path, 4663, stock), KeeperSigningStopped);
    await writeFile(path, JSON.stringify({ ...state, tasks: { [journalInput.taskId]: { consecutiveReverts: -1, failures: [] } } }));
    await assert.rejects(() => readKeeperTaskState(path, 4663, stock), KeeperSigningStopped);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("existing live, stale and damaged journal locks never get unlinked or stolen automatically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeper-lock-"));
  const path = join(directory, "4663-caller.json");
  try {
    const release = await acquireKeeperJournalLock(path);
    await assert.rejects(() => acquireKeeperJournalLock(path), /lock already exists/);
    await release();
    for (const contents of ['{"pid":99999999}', "damaged-lock"]) {
      await writeFile(`${path}.lock`, contents);
      await assert.rejects(() => acquireKeeperJournalLock(path), /operator must check/);
      assert.equal(await readFile(`${path}.lock`, "utf8"), contents);
      await rm(`${path}.lock`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("journal writers reject any private or raw-signature field before writing a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeper-private-fields-"));
  const path = join(directory, "journal.json");
  try {
    const journal = { ...journalInput, schemaVersion: 1 as const, hash: keccak256(signedTransaction), signedAt: Date.now(), status: "signed" as const };
    await assert.rejects(() => writeKeeperJournal(path, { ...journal, serializedTransaction: signedTransaction } as KeeperJournal), /forbidden fields/);
    assert.equal(await readKeeperJournal(path, 4663, stock), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("keeper claims only when a pool has income in a currency without an engine shortfall", () => {
  const healthy = "0x3333333333333333333333333333333333333333" as Address;
  const claim = (claimable: { address: Address; lp: string | null; hook: string | null }[]) => selectKeeperTasks(status({
    assets: [asset(stock, { shortfall: "5", available: "0", referenceWeth: null }), asset(healthy, { shortfall: "0", available: "0", referenceWeth: null })],
    pools: [{ address: stock, poolId, symbol: "MEME", currencies: [stock, healthy], claimable: claimable.map((entry) => ({ ...entry, symbol: "T", decimals: 18 })) }],
  })).filter((task) => task.id.startsWith("claim:"));
  assert.deepEqual(claim([{ address: stock, lp: "7", hook: "9" }, { address: healthy, lp: "0", hook: "0" }]), [],
    "income only in the short currency would be frozen in the engine");
  assert.equal(claim([{ address: stock, lp: "7", hook: "9" }, { address: healthy, lp: "1", hook: null }]).length, 1, "mixed income is still collected");
  assert.equal(claim([{ address: healthy, lp: null, hook: "3" }]).length, 1);
  const unlisted = "0x4444444444444444444444444444444444444444" as Address;
  assert.equal(claim([{ address: unlisted, lp: "1", hook: null }]).length, 1, "a currency without a recorded shortfall is healthy");
});
