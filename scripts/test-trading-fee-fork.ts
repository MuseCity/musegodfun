import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, erc20Abi, http,
  keccak256, parseAbi, parseEther, parseUnits, toHex, type Address, type Hash, type Hex } from "viem";
import artifact from "../contracts/artifacts/MusegodLaunchGuard.json";
import { assetsFor, contractsFor, sameAddress, SUPPLY } from "../src/lib/config";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import type { LaunchPlan } from "../src/lib/launch-plan";
import { assertTradingFeeCalldata } from "../src/lib/protocol";
import { runtimeFromEnv, redact } from "../server/config";
import { chainLaunchDependencies } from "../server/launch-guard";
import { LaunchpadService } from "../server/service";
import { startChainFork } from "./robinhood-fork";

// Upstream RPC is read-only behind startChainFork's allowlist. Transactions use
// only Anvil's unlocked test accounts on the asserted loopback chain 31337.
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
const sourceHash = sha256(await readFile(new URL(import.meta.url), "utf8"));
const guardArtifactHash = sha256(await readFile(new URL("../contracts/artifacts/MusegodLaunchGuard.json", import.meta.url), "utf8"));
const implementationPaths = ["src/lib/protocol.ts", "src/lib/trading-fee.ts", "server/service.ts", "server/launch-verification.ts"];
const implementationHashes = Object.fromEntries(await Promise.all(implementationPaths.map(async (path) => [path, sha256(await readFile(path, "utf8"))])));
const args = process.argv.slice(process.argv[2]?.endsWith("test-trading-fee-fork.ts") ? 3 : 2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--chain" && ["8453", "4663"].includes(args[1])), "Use --chain 8453 or --chain 4663");
const chains: (8453 | 4663)[] = args.length ? [Number(args[1]) as 8453 | 4663] : [8453, 4663];
const scheduleAbi = parseAbi(["function getFeeSchedule(bytes32 poolId) view returns(uint32 startingTime,uint24 startFee,uint24 endFee,uint24 lastFee,uint32 durationSeconds)"]);
const poolStorageAbi = parseAbi(["function extsload(bytes32 slot) view returns(bytes32)"]);
const serialize = (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value;
const report: { [key: string]: unknown; chains: Record<string, unknown>[] } = {
  scope: "Actual isolated Base and Robinhood mainnet-state forks; local candidate vesting guard; no mainnet signing, deployment, funds or writes",
  observedAt: new Date().toISOString(), status: "running", sourceHash, guardArtifactHash, implementationHashes,
  mainnetTransactions: "not_run", productionPublication: "not_run", upstreamWrites: 0, chains: [],
};
const evidencePath = `docs/evidence/trading-fee-fork${args.length ? `-${args[1]}` : ""}.json`;
await mkdir("docs/evidence", { recursive: true });
const save = () => writeFile(evidencePath, JSON.stringify(report, serialize, 2) + "\n");
await save();

for (const deploymentChainId of chains) {
  console.log(`Trading fee fork: ${deploymentChainId}`);
  const upstreamRuntime = runtimeFromEnv(deploymentChainId);
  assert.notEqual(upstreamRuntime.config.mode, "fork", "Provide mainnet read-only providers for isolated test forks");
  const fork = await startChainFork(upstreamRuntime.rpcUrl, deploymentChainId);
  const directory = await mkdtemp(join(tmpdir(), "musegod-trading-fee-fork-"));
  const chain = defineChain({ id: 31337, name: "Isolated trading fee acceptance", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [fork.rpc] } } });
  const client = createPublicClient({ chain, transport: http(fork.rpc, { timeout: 180_000, retryCount: 0 }) });
  const accounts = await fork.rpcCall("eth_accounts") as Address[];
  const creator = accounts[0], treasury = accounts[1];
  const wallet = createWalletClient({ chain, account: creator, transport: http(fork.rpc, { timeout: 180_000, retryCount: 0 }) });
  const snapshot = await fork.rpcCall("evm_snapshot");
  const row: Record<string, unknown> & { launches: Record<string, unknown>[] } = { deploymentChainId, executionChainId: 31337,
    forkBlockNumber: fork.blockNumber, status: "running", snapshotRestored: false, upstreamWrites: 0, launches: [] };
  report.chains.push(row);
  let service: LaunchpadService | undefined;
  try {
    assert.equal(new URL(fork.rpc).hostname, "127.0.0.1");
    assert.equal(await client.getChainId(), 31337);
    const pinnedBlock = await fork.upstream.getBlock({ blockNumber: fork.blockNumber });
    row.forkBlockHash = pinnedBlock.hash;
    const dependencies = chainLaunchDependencies(deploymentChainId), contracts = contractsFor({ deploymentChainId, mode: "fork" });
    const confirm = async (hash: Hash) => {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      assert.equal(receipt.status, "success", "The local fork transaction must settle successfully");
      await fork.rpcCall("evm_mine");
      return receipt;
    };
    await fork.rpcCall("anvil_setBalance", [creator, toHex(parseEther("100"))]);
    const deployment = await confirm(await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode as Hex,
      args: [dependencies.bundler], gas: 5_000_000n }));
    const guard = deployment.contractAddress!;
    row.guard = guard;
    row.guardRevision = "local_candidate_vesting";
    row.guardDeploymentHash = deployment.transactionHash;
    const runtime = { ...upstreamRuntime, config: { ...upstreamRuntime.config, mode: "fork" as const, chainId: 31337,
      deploymentChainId, treasury, writesEnabled: true, feeEngine: null, feePolicy: FEE_POLICY, launchGuard: null },
      rpcUrl: fork.rpc, dataDir: directory, supabase: undefined, launchGuardCandidate: null, firstBuyGuardCandidate: guard };
    service = new LaunchpadService(runtime);
    const config = await service.config();
    assert.equal(config.launchLockAvailable, true);
    assert(sameAddress(config.launchGuard!, guard));
    const asset = assetsFor(runtime.config).find((item) => item.ticker === (deploymentChainId === 4663 ? "WETH" : "NVDA"))!;
    const firstBuyInput = parseUnits("0.001", asset.decimals), fundAmount = firstBuyInput * 4n;
    row.asset = { address: asset.address, ticker: asset.ticker, decimals: asset.decimals };
    const balance = (address: Address, account: Address) => client.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    if (deploymentChainId === 4663) {
      const funded = await confirm(await wallet.writeContract({ address: asset.address, abi: parseAbi(["function deposit() payable"]), functionName: "deposit", value: fundAmount }));
      row.funding = { kind: "actual_WETH_deposit_using_local_Anvil_ETH", amount: fundAmount, hash: funded.transactionHash };
    } else {
      const donor = contracts.poolManager, donorBefore = await balance(asset.address, donor);
      assert(donorBefore >= fundAmount, "Base PoolManager must hold genuine NVDA inventory");
      await fork.rpcCall("anvil_setBalance", [donor, toHex(parseEther("1"))]);
      await fork.rpcCall("anvil_impersonateAccount", [donor]);
      try {
        const donorWallet = createWalletClient({ chain, account: donor, transport: http(fork.rpc, { timeout: 180_000 }) });
        const funded = await confirm(await donorWallet.writeContract({ address: asset.address, abi: erc20Abi, functionName: "transfer", args: [creator, fundAmount] }));
        assert.equal(donorBefore - await balance(asset.address, donor), fundAmount);
        row.funding = { kind: "genuine_fork_inventory_transfer_by_local_impersonation", donor, amount: fundAmount, hash: funded.transactionHash };
      } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [donor]); }
    }
    assert.equal(await balance(asset.address, creator), fundAmount);
    for (const tradingFeeBps of [100, 300]) for (const flow of ["plain", "first_buy", "locked_first_buy"] as const) {
      console.log(`Trading fee fork: ${deploymentChainId} ${tradingFeeBps} bps ${flow}`);
      const input = { name: `Fee ${tradingFeeBps} ${flow}`, symbol: `F${tradingFeeBps}`, description: "Isolated trading-fee acceptance", image: "", quoteAddress: asset.address,
        ...(tradingFeeBps === 100 ? {} : { tradingFeeBps }) };
      const firstBuy = flow === "plain" ? undefined : { amount: "0.001", slippageBps: 100, lockDays: flow === "locked_first_buy" ? 30 : 0 };
      const previewAttempts: Record<string, unknown>[] = [];
      let preparedPlan: LaunchPlan | undefined;
      // A slow cold fork may consume the existing 60-second LI.FI price TTL.
      // Retry only an expired unsigned preview; never extend that TTL or retry
      // a submitted launch. Preserve each failure in the successful evidence.
      for (let attempt = 1; attempt <= 3; attempt++) {
        const startedAt = Date.now();
        try {
          preparedPlan = await service.prepare(input, creator, CURVE_POLICY, firstBuy);
          previewAttempts.push({ attempt, elapsedMs: Date.now() - startedAt, status: "prepared" });
          break;
        } catch (error) {
          const message = redact(error);
          previewAttempts.push({ attempt, elapsedMs: Date.now() - startedAt, status: "failed_before_submission", error: message });
          if (attempt === 3 || !message.includes("The opening valuation price expired")) throw error;
          console.log(`Retry unsigned expired preview: ${deploymentChainId} ${tradingFeeBps} bps ${flow}`);
        }
      }
      assert(preparedPlan);
      const plan = preparedPlan;
      assert.equal(plan.draft.tradingFeeBps, tradingFeeBps);
      assert(plan.prepared && plan.transaction);
      assertTradingFeeCalldata(plan.draft.tradingFeeBps, plan.prepared.createParams.poolInitializerData, contracts.rehype);
      assert.equal(plan.firstBuy?.lockDays ?? 0, firstBuy?.lockDays ?? 0);
      const before = await balance(asset.address, creator);
      if (plan.approval?.required) await confirm(await wallet.sendTransaction({ to: plan.approval.transaction.to, data: plan.approval.transaction.data, value: 0n }));
      const simulation = await service.simulateLaunch(creator, plan.data);
      const receipt = await confirm(await wallet.sendTransaction({ to: plan.transaction.to, data: plan.data, value: 0n, gas: BigInt(simulation.gas) * 150n / 100n + 50_000n }));
      const token = await service.register(receipt.transactionHash);
      assert.equal(token.tradingFeeBps, tradingFeeBps);
      assert.equal((await service.store.tokens()).find((item) => sameAddress(item.address, token.address))?.tradingFeeBps, tradingFeeBps);
      const schedule = await client.readContract({ address: contracts.rehype, abi: scheduleAbi, functionName: "getFeeSchedule", args: [token.poolId], blockNumber: receipt.blockNumber });
      assert.deepEqual(schedule.slice(1), [tradingFeeBps * 100, tradingFeeBps * 100, tradingFeeBps * 100, 0]);
      const state = await (await service.sdk.getMulticurvePool(token.address)).getState();
      assert.equal(state.status, 2);
      assert.equal(state.poolKey.fee, 0x800000);
      const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [token.poolId, 6n]));
      const raw = BigInt(await client.readContract({ address: contracts.poolManager, abi: poolStorageAbi, functionName: "extsload", args: [slot], blockNumber: receipt.blockNumber }));
      assert.equal(Number(raw >> 208n & ((1n << 24n) - 1n)), 500);
      assert.equal(await client.readContract({ address: token.address, abi: erc20Abi, functionName: "totalSupply" }), SUPPLY);
      const spent = before - await balance(asset.address, creator);
      assert.equal(spent, firstBuy ? firstBuyInput : 0n);
      if (flow === "first_buy") assert.equal(await balance(token.address, creator), BigInt(plan.firstBuy!.expectedAmountOut));
      if (flow === "locked_first_buy") {
        assert.equal(token.firstBuyLock?.lockDays, 30);
        assert.equal(await balance(token.address, creator), 0n);
        assert.equal(await balance(token.address, dependencies.bundler), BigInt(token.firstBuyLock!.totalAmount));
        assert.equal((await service.firstBuyLock(token.address))?.claimableAmount, "0");
      }
      row.launches.push({ flow, tradingFeeBps, requestOmittedFeeField: tradingFeeBps === 100, transactionHash: receipt.transactionHash,
        tokenAddress: token.address, poolId: token.poolId, receiptBlockNumber: receipt.blockNumber, receiptBlockHash: receipt.blockHash,
        calldataAndSavedRecordVerified: true, schedule: { startingTime: schedule[0], startFee: schedule[1], endFee: schedule[2], lastFee: schedule[3], durationSeconds: schedule[4] },
        dynamicPoolKeyFee: state.poolKey.fee, actualLpFeePpm: 500, actualFirstBuyInput: spent, expectedFirstBuyOutput: plan.firstBuy?.expectedAmountOut ?? null,
        previewAttempts, firstBuyLock: token.firstBuyLock ?? null });
      await save();
      console.log(`PASS ${deploymentChainId}: ${tradingFeeBps} bps ${flow} create/register/receipt-block schedule`);
    }
    assert.equal(await balance(asset.address, creator), 0n);
    row.status = "passed";
  } catch (error) {
    row.status = "failed";
    row.error = redact(error);
    report.status = "failed";
    throw new Error(`Trading fee fork failed on ${deploymentChainId}: ${redact(error)}`);
  } finally {
    try {
      row.snapshotRestored = await fork.rpcCall("evm_revert", [snapshot]);
      assert.equal(row.snapshotRestored, true);
      row.upstreamWrites = fork.blockedUpstreamWrites();
      assert.equal(row.upstreamWrites, 0);
      report.upstreamWrites = report.chains.reduce((sum, item) => sum + Number(item.upstreamWrites), 0);
    } finally {
      try { await service?.store.close(); }
      finally { await fork.stop(); await rm(directory, { recursive: true, force: true }); await save(); }
    }
  }
}
report.status = "passed";
report.completedAt = new Date().toISOString();
await save();
console.log(`PASS: trading fee fork acceptance; evidence ${evidencePath}`);
