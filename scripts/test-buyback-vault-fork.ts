import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, getAddress, http, keccak256, parseEventLogs, type Address, type Hex, type Abi } from "viem";
import { robinhood } from "viem/chains";
import { loadEnvironment, runtimeFromEnv, redact } from "../server/config";
import { buybackAmountCandidates, buybackVaultAbi } from "../src/lib/buyback-engine";
import { verifiedFlashBurn } from "../server/buyback-engine";
import { startRobinhoodFork } from "./robinhood-fork";

// Separate execution fixture: deliberately advance fork time at unchanged spot.
// This must never be presented as a currently executable mainnet buyback.
loadEnvironment();
const raw = await readFile("contracts/artifacts/buyback-v2/MusegodBuybackBudgetVault.json", "utf8");
const artifact = JSON.parse(raw) as { abi: Abi; bytecode: Hex };
const historical = JSON.parse(await readFile("contracts/artifacts/buyback-deployment.json", "utf8"));
const c = historical.constants;
const fork = await startRobinhoodFork(runtimeFromEnv().rpcUrl);
const chain = { ...robinhood, id: 31337, name: "Isolated stable-price settlement fixture" };
const client = createPublicClient({ chain, transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }) });
assert.equal(await client.getChainId(), 31337);
const [creator, caller] = await fork.rpcCall("eth_accounts") as Address[];
const wallet = createWalletClient({ chain, account: creator, transport: http(fork.rpc) });
const publicWallet = createWalletClient({ chain, account: caller, transport: http(fork.rpc) });
const snapshot = await fork.rpcCall("evm_snapshot");
const result: Record<string, unknown> = { scope: "Isolated real-contract settlement with explicit stable-spot time fixture", chainId: 31337,
  upstreamChainId: 4663, forkBlock: String(fork.blockNumber), mainnetWrites: false, mainnetExecutableProof: false,
  priceOrBalanceStorageOverrides: false, historicalPoolStateRetained: true,
  artifactSha256: createHash("sha256").update(raw).digest("hex"), sourceSha256: createHash("sha256").update(await readFile(new URL(import.meta.url), "utf8")).digest("hex"), passed: false };
let vault: Address | undefined, failure: unknown;
const balance = (token: Address, account: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
const weth = getAddress(c.weth), muse = getAddress(c.muse), dead = getAddress(c.beneficiary), swapper = getAddress(historical.contracts.swapper.address);
const originalSwapper = await balance(weth, swapper);
try {
  const deployment = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode,
    args: [weth, muse, getAddress(historical.contracts.oracle.address), swapper, getAddress(historical.contracts.executor.address)], gas: 5_000_000n }) });
  assert.equal(deployment.status, "success"); assert(deployment.contractAddress); vault = deployment.contractAddress;
  result.deployment = { address: vault, hash: deployment.transactionHash, block: String(deployment.blockNumber), runtimeHash: keccak256((await client.getCode({ address: vault }))!) };
  try { result.originalPriceCheck = await client.readContract({ address: vault, abi: buybackVaultAbi, functionName: "checkPrices" }); }
  catch (error) { result.originalPriceCheck = { status: "waiting", reason: redact(error) }; }
  const deposited = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: weth, data: "0xd0e30db0", value: 10n ** 16n, gas: 150_000n }) });
  assert.equal(deposited.status, "success");
  const funded = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: weth, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [vault, 10n ** 16n] }), gas: 150_000n }) });
  assert.equal(funded.status, "success");
  result.funding = { deposit: deposited.transactionHash, transfer: funded.transactionHash, amount: String(10n ** 16n), source: "real WETH deposit from local unlocked fixture account" };
  const beforeTime = (await client.getBlock()).timestamp;
  await fork.rpcCall("evm_setNextBlockTimestamp", [Number(beforeTime + 1801n)]); await fork.rpcCall("anvil_mine", [1]);
  result.timeFixture = { before: String(beforeTime), after: String((await client.getBlock()).timestamp), seconds: 1801,
    interpretation: "hypothetical unchanged spot for 30 minutes; not observed market history or live activation evidence" };
  result.fixturePrices = await client.readContract({ address: vault, abi: buybackVaultAbi, functionName: "checkPrices" });
  let selected: { amount: bigint; deadline: bigint; gas: bigint } | undefined;
  for (const amount of buybackAmountCandidates(10n ** 16n)) {
    const deadline = (await client.getBlock()).timestamp + 60n;
    try {
      await client.simulateContract({ address: vault, abi: buybackVaultAbi, functionName: "execute", args: [amount, 1n, deadline], account: caller });
      const gas = await client.estimateContractGas({ address: vault, abi: buybackVaultAbi, functionName: "execute", args: [amount, 1n, deadline], account: caller });
      selected = { amount, deadline, gas }; break;
    } catch { /* Same floor and cap; a smaller amount may have less price impact. */ }
  }
  assert(selected, "Stable-price fixture must find a real positive-surplus execution");
  const before = { vault: await balance(weth, vault), dead: await balance(muse, dead), caller: await balance(muse, caller), supply: await client.readContract({ address: muse, abi: erc20Abi, functionName: "totalSupply" }) };
  const receipt = await client.waitForTransactionReceipt({ hash: await publicWallet.writeContract({ address: vault, abi: buybackVaultAbi, functionName: "execute", args: [selected.amount, 1n, selected.deadline], gas: selected.gas * 3n / 2n }) });
  assert.equal(receipt.status, "success");
  const burned = await balance(muse, dead) - before.dead, profit = await balance(muse, caller) - before.caller;
  assert(burned > 0n && profit > 0n);
  assert.equal(verifiedFlashBurn(receipt, swapper), burned);
  assert.equal(await balance(weth, vault), before.vault - selected.amount);
  assert.equal(await balance(weth, swapper), originalSwapper);
  assert.equal(await client.readContract({ address: vault, abi: buybackVaultAbi, functionName: "rollingSpent" }), selected.amount);
  assert.equal(await client.readContract({ address: vault, abi: buybackVaultAbi, functionName: "totalBurned" }), burned);
  assert.equal(await client.readContract({ address: vault, abi: buybackVaultAbi, functionName: "totalSpent" }), selected.amount);
  assert.equal(await client.readContract({ address: muse, abi: erc20Abi, functionName: "totalSupply" }), before.supply);
  const executions = parseEventLogs({ abi: buybackVaultAbi, logs: receipt.logs.filter((log) => log.address.toLowerCase() === vault!.toLowerCase()), strict: true });
  assert.equal(executions.length, 1);
  assert.equal(executions[0].args.caller.toLowerCase(), caller.toLowerCase());
  assert.equal(executions[0].args.wethAmount, selected.amount);
  assert.equal(executions[0].args.museToDead, burned);
  assert.equal(executions[0].args.profit, profit);
  result.settlement = { hash: receipt.transactionHash, block: String(receipt.blockNumber), amount: String(selected.amount), burned: String(burned), profit: String(profit), gasUsed: String(receipt.gasUsed), gasCostWei: String(receipt.gasUsed * receipt.effectiveGasPrice), gasProfitabilityProven: false,
    exactVaultDebit: true, originalSwapperBalancePreserved: true, actualDeadTransferVerified: true, rollingCounterExact: true, erc20TotalSupplyUnchanged: true, executions };
  result.passed = true;
} catch (error) { failure = error; result.failure = redact(error); }
finally {
  try { assert.equal(await fork.rpcCall("evm_revert", [snapshot]), true); if (vault) assert.equal(await client.getCode({ address: vault }) ?? "0x", "0x"); assert.equal(await balance(weth, swapper), originalSwapper); result.snapshotRestored = true; }
  catch (error) { result.cleanupFailure = redact(error); failure ??= error; }
  result.blockedUpstreamWrites = fork.blockedUpstreamWrites(); await fork.stop(); assert.equal(result.blockedUpstreamWrites, 0);
  await writeFile("docs/evidence/buyback-v2-vault-fixture.json", JSON.stringify(result, (_key, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n");
}
if (failure) throw new Error(redact(failure));
console.log(JSON.stringify({ passed: result.passed, mainnetExecutableProof: false, snapshotRestored: result.snapshotRestored, blockedUpstreamWrites: result.blockedUpstreamWrites }));
