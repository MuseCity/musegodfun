import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundlerAbi } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, http, parseAbi, parseEther, parseUnits, toHex, type Address, type Hash, type Hex } from "viem";
import artifact from "../contracts/artifacts/MusegodLaunchGuard.json";
import { assetsFor, contractsFor, sameAddress } from "../src/lib/config";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { chainLaunchDependencies } from "../server/launch-guard";
import { LaunchpadService } from "../server/service";
import { runtimeFromEnv, redact } from "../server/config";
import { startChainFork } from "./robinhood-fork";

// Every write in this acceptance script targets an isolated loopback chain 31337.
const sourceHash = createHash("sha256").update(await readFile(new URL(import.meta.url), "utf8")).digest("hex");
const artifactHash = createHash("sha256").update(await readFile(new URL("../contracts/artifacts/MusegodLaunchGuard.json", import.meta.url), "utf8")).digest("hex");
const evidence: unknown[] = [];
const requested = process.argv.slice(process.argv[2]?.endsWith("test-first-buy-lock-fork.ts") ? 3 : 2);
assert(requested.length === 0 || (requested.length === 2 && requested[0] === "--chain" && ["8453", "4663"].includes(requested[1])), "Use --chain 8453 or --chain 4663");
const chains: (8453 | 4663)[] = requested.length ? [Number(requested[1]) as 8453 | 4663] : [8453, 4663];
for (const deploymentChainId of chains) {
  console.log(`First buy lock fork: ${deploymentChainId}`);
  const upstreamRuntime = runtimeFromEnv(deploymentChainId);
  const fork = await startChainFork(upstreamRuntime.rpcUrl, deploymentChainId);
  const directory = await mkdtemp(join(tmpdir(), "first-buy-lock-fork-"));
  let service: LaunchpadService | undefined;
  const chain = defineChain({ id: 31337, name: "Isolated first-buy lock fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [fork.rpc] } } });
  const client = createPublicClient({ chain, transport: http(fork.rpc, { timeout: 180_000, retryCount: 0 }) });
  const accounts = await fork.rpcCall("eth_accounts") as Address[];
  const creator = accounts[0], treasury = accounts[1];
  const wallet = createWalletClient({ chain, account: creator, transport: http(fork.rpc) });
  const snapshot = await fork.rpcCall("evm_snapshot");
  let snapshotRestored = false;
  try {
    assert.equal(await client.getChainId(), 31337);
    const dependencies = chainLaunchDependencies(deploymentChainId), contracts = contractsFor({ mode: deploymentChainId === 4663 ? "robinhood" : "base" });
    const confirm = async (hash: Hash) => {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      assert.equal(receipt.status, "success");
      await fork.rpcCall("evm_mine");
      return receipt;
    };
    await fork.rpcCall("anvil_setBalance", [creator, toHex(parseEther("100"))]);
    const deployment = await confirm(await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode as Hex,
      args: [dependencies.bundler], gas: 5_000_000n }));
    const guard = deployment.contractAddress!;
    const runtime = { ...upstreamRuntime, config: { ...upstreamRuntime.config, mode: "fork" as const, chainId: 31337,
      deploymentChainId, treasury, writesEnabled: true, feeEngine: null, feePolicy: FEE_POLICY, launchGuard: null },
      rpcUrl: fork.rpc, dataDir: directory, supabase: undefined, launchGuardCandidate: null, firstBuyGuardCandidate: guard };
    service = new LaunchpadService(runtime);
    assert.equal((await service.config()).launchLockAvailable, true);
    const asset = assetsFor(runtime.config).find((row) => row.ticker === (deploymentChainId === 4663 ? "WETH" : "NVDA"))!;
    const input = parseUnits("0.001", asset.decimals);
    const balance = (token: Address, account: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    if (deploymentChainId === 4663) {
      await confirm(await wallet.writeContract({ address: asset.address, abi: parseAbi(["function deposit() payable"]), functionName: "deposit", value: input }));
    } else {
      // Transfer genuine inventory only. No token code, ledger or oracle replacement is allowed.
      const donor = contracts.poolManager;
      assert((await balance(asset.address, donor)) >= input, "Base PoolManager must have genuine NVDA inventory for this fork acceptance");
      await fork.rpcCall("anvil_setBalance", [donor, toHex(parseEther("1"))]);
      await fork.rpcCall("anvil_impersonateAccount", [donor]);
      try {
        const donorWallet = createWalletClient({ chain, account: donor, transport: http(fork.rpc) });
        await confirm(await donorWallet.writeContract({ address: asset.address, abi: erc20Abi, functionName: "transfer", args: [creator, input] }));
      } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [donor]); }
    }
    const beforeQuote = await balance(asset.address, creator);
    const plan = await service.prepare({ name: "First Buy Lock Acceptance", symbol: "LOCK", description: "", image: "", quoteAddress: asset.address },
      creator, CURVE_POLICY, { amount: "0.001", slippageBps: 100, lockDays: 30 });
    assert.equal(plan.firstBuy?.lockDays, 30);
    await confirm(await wallet.sendTransaction({ to: plan.approval!.transaction.to, data: plan.approval!.transaction.data, value: 0n }));
    const simulation = await service.simulateLaunch(creator, plan.data);
    const receipt = await confirm(await wallet.sendTransaction({ to: guard, data: plan.data, value: 0n, gas: BigInt(simulation.gas) * 150n / 100n + 50_000n }));
    const token = await service.register(receipt.transactionHash);
    const record = token.firstBuyLock!;
    assert(record && sameAddress(record.recipient, creator));
    assert.equal(beforeQuote - await balance(asset.address, creator), input);
    assert.equal(await balance(token.address, creator), 0n);
    assert.equal(await balance(token.address, dependencies.bundler), BigInt(record.totalAmount));
    assert.equal((await service.firstBuyLock(token.address))?.claimableAmount, "0");
    await assert.rejects(() => client.simulateContract({ address: dependencies.bundler, abi: bundlerAbi, functionName: "claim", args: [token.address], account: creator }));
    await fork.rpcCall("evm_setNextBlockTimestamp", [record.start + record.vestingDuration]);
    await fork.rpcCall("evm_mine");
    const claim = await service.firstBuyLock(token.address);
    assert.equal(claim?.claimableAmount, record.totalAmount);
    await assert.rejects(() => client.simulateContract({ address: dependencies.bundler, abi: bundlerAbi, functionName: "claim", args: [token.address], account: treasury }));
    const claimReceipt = await confirm(await wallet.sendTransaction({ to: claim!.claimTransaction!.to, data: claim!.claimTransaction!.data, value: 0n }));
    assert.equal(await balance(token.address, creator), BigInt(record.totalAmount));
    assert.equal(await balance(token.address, dependencies.bundler), 0n);
    assert.equal((await service.firstBuyLock(token.address))?.claimableAmount, "0");
    assert.equal(await client.readContract({ address: asset.address, abi: erc20Abi, functionName: "allowance", args: [guard, dependencies.bundler] }), 0n);
    evidence.push({ deploymentChainId, forkBlockNumber: String(fork.blockNumber), executionChainId: 31337,
      asset: asset.address, guard, launchHash: receipt.transactionHash, claimHash: claimReceipt.transactionHash,
      tokenAddress: token.address, lock: record, actualInput: String(input), snapshotRestored: true, upstreamWrites: fork.blockedUpstreamWrites() });
    console.log(`PASS: ${deploymentChainId} actual custody / locked claim rejection / full creator claim`);
  } catch (error) {
    console.error(redact(error));
    throw new Error(`First buy lock fork failed on ${deploymentChainId}`);
  } finally {
    try {
      snapshotRestored = await fork.rpcCall("evm_revert", [snapshot]);
      assert.equal(snapshotRestored, true);
      assert.equal(fork.blockedUpstreamWrites(), 0);
    } finally {
      try { await service?.store.close(); }
      finally { await fork.stop(); await rm(directory, { recursive: true, force: true }); }
    }
  }
}
await mkdir(".cache", { recursive: true });
await writeFile(`.cache/first-buy-lock-fork-${requested[1] || "both"}.json`, JSON.stringify({ sourceHash, artifactHash, mainnetTransactions: "not_run", chains: evidence }, null, 2));
