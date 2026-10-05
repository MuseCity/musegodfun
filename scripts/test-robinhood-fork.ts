import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, keccak256,
  http, parseAbi, parseAbiItem, parseEther, parseUnits, toHex, zeroAddress,
  type Address, type Hash,
} from "viem";
import { robinhood } from "viem/chains";
import { DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { contractsFor, ROBINHOOD_STOCKS, SUPPLY, WAD, sameAddress } from "../src/lib/config";
import { claimFeesAbi, permit2Abi, swapTransaction } from "../src/lib/protocol";
import { allocateFeeIncome, FEE_POLICY } from "../src/lib/fee-policy";
import { LaunchpadService } from "../server/service";
import { OPENING_CAP_USD, OPENING_POLICY } from "../src/lib/opening-valuation";
import { redact, runtimeFromEnv } from "../server/config";
import { startRobinhoodFork } from "./robinhood-fork";

const runtime = runtimeFromEnv();
assert.equal(runtime.config.mode, "robinhood", "Use CHAIN_MODE=robinhood for the read provider");
assert.equal(runtime.config.chainId, 4663);
const fork = await startRobinhoodFork(runtime.rpcUrl);
const dataDir = await mkdtemp(join(tmpdir(), "musegod-robinhood-fork-"));
const forkConfig = {
  mode: "fork" as const, chainId: 31337, deploymentChainId: 4663 as const,
  treasury: null as Address | null, writesEnabled: true, blockReason: null,
};
const contracts = contractsFor(forkConfig);
const forkChain = { ...robinhood, id: 31337, name: "Isolated Robinhood Chain fork" };
const client = createPublicClient({
  chain: forkChain, transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }),
});
const accounts: Address[] = await fork.rpcCall("eth_accounts");
const creator = accounts[0], treasury = accounts[1];
assert(creator && treasury && !sameAddress(creator, treasury));
forkConfig.treasury = treasury;
const wallet = createWalletClient({ chain: forkChain, account: creator, transport: http(fork.rpc) });
const treasuryWallet = createWalletClient({ chain: forkChain, account: treasury, transport: http(fork.rpc) });
const sdk = new DopplerSDK<4663>({
  chainId: 4663,
  publicClient: createPublicClient({ chain: robinhood,
    transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }),
  }).extend(() => ({ getChainId: async () => 4663 })),
});
const serviceRuntime = { config: forkConfig, rpcUrl: fork.rpc, dataDir };
let service = new LaunchpadService(serviceRuntime);
const snapshot = await fork.rpcCall("evm_snapshot");
let snapshotRestored = false;
const testedTokens: Address[] = [];
const evidence: Record<string, unknown>[] = [];
const testedTickers = ["WETH", "NVDA", "USDG", "cbBTC", "MUSEGOD"];
const sharesAbi = parseAbi(["function getShares(bytes32 poolId,address beneficiary) view returns(uint256)"]);
const wethAbi = parseAbi(["function deposit() payable"]);
const stockAbi = parseAbi(["function uiMultiplier() view returns(uint256)", "function paused() view returns(bool)"]);
const balance = (asset: Address, account: Address) => client.readContract({
  address: asset, abi: erc20Abi, functionName: "balanceOf", args: [account],
});
async function confirmed(hash: Hash) {
  await fork.rpcCall("anvil_mine", [2]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const transaction = await client.getTransaction({ hash });
    const trace = await fork.rpcCall("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
    await writeFile(".cache/robinhood-reverted-transaction.json", JSON.stringify({ receipt, transaction, trace },
      (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n");
    throw new Error(`Local fork transaction reverted: ${hash}; gas used ${receipt.gasUsed} of ${transaction.gas}; see .cache/robinhood-reverted-transaction.json`);
  }
  return receipt;
}
async function fundAsset(asset: typeof ROBINHOOD_STOCKS[number], amount: bigint) {
  if (asset.symbol === "WETH") {
    const before = await balance(asset.address, creator);
    const receipt = await confirmed(await wallet.writeContract({
      address: asset.address, abi: wethAbi, functionName: "deposit", value: amount,
    }));
    assert.equal(await balance(asset.address, creator) - before, amount);
    return { kind: "real_WETH_deposit_on_local_fork", hash: receipt.transactionHash, amount };
  }
  // Existing inventory, never a fabricated token balance or replacement contract.
  // Impersonation is available only on this isolated loopback fork.
  const candidates: Address[] = [contracts.poolManager];
  const transfers = await fork.upstream.getLogs({
    address: asset.address,
    event: parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)"),
    fromBlock: fork.blockNumber - 9n, toBlock: fork.blockNumber,
  });
  candidates.push(...transfers.flatMap((log) => [log.args.to, log.args.from])
    .filter((address): address is Address => !!address && !sameAddress(address, zeroAddress)));
  if (candidates.length === 1) {
    const response = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${asset.address}/holders`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      const body = await response.json();
      for (const item of (body.items ?? []).slice(0, 20))
        if (/^0x[0-9a-fA-F]{40}$/.test(item.address?.hash)) candidates.push(item.address.hash);
    }
  }
  for (const donor of [...new Set(candidates)]) {
    if (sameAddress(donor, creator) || sameAddress(donor, treasury)) continue;
    const donorBefore = await balance(asset.address, donor);
    if (donorBefore < amount) continue;
    await fork.rpcCall("anvil_setBalance", [donor, toHex(parseEther("1"))]);
    try {
      await client.simulateContract({ address: asset.address, abi: erc20Abi,
        functionName: "transfer", args: [creator, amount], account: donor });
    } catch { continue; }
    await fork.rpcCall("anvil_impersonateAccount", [donor]);
    try {
      const donorWallet = createWalletClient({ chain: forkChain, account: donor, transport: http(fork.rpc) });
      const before = await balance(asset.address, creator);
      const receipt = await confirmed(await donorWallet.writeContract({ address: asset.address,
        abi: erc20Abi, functionName: "transfer", args: [creator, amount] }));
      assert.equal(await balance(asset.address, creator) - before, amount);
      assert.equal(donorBefore - await balance(asset.address, donor), amount);
      return { kind: "verified_existing_inventory_transfer_on_local_fork", donor,
        hash: receipt.transactionHash, amount, donorBefore };
    } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [donor]); }
  }
  throw new Error(`No genuine transferable ${asset.symbol} inventory found for isolated fork funding`);
}
try {
  for (const ticker of testedTickers) {
    const asset = ROBINHOOD_STOCKS.find((row) => row.ticker === ticker);
    assert(asset, `Curated whitelist must contain ${ticker}`);
    console.log(`Robinhood fork: ${ticker} create / register / buy / sell / both beneficiaries' fees`);
    if (ticker === "NVDA") {
      assert.equal(await client.readContract({ address: asset.address, abi: stockAbi, functionName: "paused" }), false);
      assert((await client.readContract({ address: asset.address, abi: stockAbi, functionName: "uiMultiplier" })) > 0n);
    }
    const amount = parseUnits(["USDG", "MUSEGOD"].includes(ticker) ? "20" : "0.02", asset.decimals);
    const funding = await fundAsset(asset, amount);
    const plan = await service.prepare({
      name: `Robinhood ${ticker} Fork Proof`, symbol: `RH${ticker.toUpperCase()}`,
      description: "Isolated local Robinhood Chain fork acceptance. No mainnet transaction.",
      image: "", quoteAddress: asset.address,
    }, creator);
    assert.equal(plan.feePolicy, FEE_POLICY);
    assert(sameAddress(plan.feeTreasury!, treasury));
    assert.deepEqual(await service.validateLaunch(creator, plan.data), { valid: true, feePolicy: FEE_POLICY });
    const launchHash = await wallet.sendTransaction({ to: contracts.airlock, data: plan.data, value: 0n });
    await service.trackLaunch(launchHash, plan.id);
    await confirmed(launchHash);
    await service.store.close();
    service = new LaunchpadService(serviceRuntime);
    service.runtime.config.writesEnabled = false;
    await service.reconcile();
    assert.equal((await service.store.token(plan.tokenAddress))?.address, plan.tokenAddress,
      "Server restart recovers already submitted issuance while new signing is disabled");
    service.runtime.config.writesEnabled = true;
    const registered = await service.register(launchHash);
    testedTokens.push(registered.address);
    assert.equal((await service.register(launchHash)).address, registered.address);
    assert.equal(registered.mode, "fork");
    assert.equal(registered.feePolicy, FEE_POLICY);
    assert.equal(registered.openingValuation?.policy, OPENING_POLICY);
    assert.equal(registered.openingValuation.marketCapUsd, OPENING_CAP_USD);
    const pool = await sdk.getMulticurvePool(registered.address);
    const state = await pool.getState();
    assert.equal(state.status, 2);
    assert.equal(state.poolKey.fee, 8388608);
    assert(sameAddress(state.numeraire, asset.address));
    assert(sameAddress(state.poolKey.hooks, contracts.initializer));
    assert.equal((await service.state(registered.address)).token.poolId, plan.poolId);
    assert.equal(await client.readContract({ address: registered.address, abi: erc20Abi, functionName: "totalSupply" }), SUPPLY);
    // Uniswap v4 StateLibrary: pools mapping is storage slot 6; Slot0's
    // low 160 bits contain sqrtPriceX96. Read the actual new pool before buys.
    const priceBlock = await client.getBlockNumber();
    const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [registered.poolId, 6n]));
    const slot0 = await client.readContract({ address: contracts.poolManager,
      abi: parseAbi(["function extsload(bytes32 slot) view returns(bytes32)"]),
      functionName: "extsload", args: [slot], blockNumber: priceBlock });
    const sqrtPriceX96 = BigInt(slot0) & ((1n << 160n) - 1n);
    assert(sqrtPriceX96 > 0n);
    const memeIs0 = sameAddress(state.poolKey.currency0, registered.address);
    const squared = sqrtPriceX96 * sqrtPriceX96, q192 = 1n << 192n;
    const numerator = (memeIs0 ? squared : q192) * 10n ** 18n;
    const denominator = (memeIs0 ? q192 : squared) * 10n ** BigInt(asset.decimals);
    const actualOpeningCapUsd = Number(numerator) / Number(denominator)
      * Number(registered.openingValuation.quotePriceUsd) * 1_000_000_000;
    assert(Math.abs(actualOpeningCapUsd / OPENING_CAP_USD - 1) <= 1.0001 ** 10 - 1 + 1e-8,
      `${ticker}: initial pool valuation ${actualOpeningCapUsd} exceeds tickSpacing=10 rounding tolerance`);
    const owner = await sdk.getAirlockOwner();
    const readShare = (contract: Address, account: Address) => client.readContract({
      address: contract, abi: sharesAbi, functionName: "getShares", args: [registered.poolId, account],
    });
    const shares = await Promise.all([
      readShare(contracts.initializer, owner), readShare(contracts.initializer, creator),
      readShare(contracts.initializer, treasury), readShare(contracts.rehype, creator),
      readShare(contracts.rehype, treasury),
    ]);
    assert.deepEqual(shares, [WAD * 5n / 100n, WAD * 665n / 1000n, WAD * 285n / 1000n,
      WAD * 70n / 100n, WAD * 30n / 100n]);
    async function trade(currencyIn: Address, amountIn: bigint) {
      const side = sameAddress(currencyIn, asset!.address) ? "buy" : "sell";
      const quote = await service.quote(registered.address, side,
        formatUnits(amountIn, side === "buy" ? asset!.decimals : 18), 100);
      const deadline = (await client.getBlock()).timestamp + 300n;
      if ((await client.readContract({ address: currencyIn, abi: erc20Abi,
        functionName: "allowance", args: [creator, contracts.permit2] })) < amountIn)
        await confirmed(await wallet.writeContract({ address: currencyIn, abi: erc20Abi,
          functionName: "approve", args: [contracts.permit2, amountIn] }));
      await confirmed(await wallet.writeContract({ address: contracts.permit2, abi: permit2Abi,
        functionName: "approve", args: [currencyIn, contracts.router, amountIn, Number(deadline)] }));
      const tx = swapTransaction(state.poolKey, currencyIn, amountIn, BigInt(quote.amountOut), 100, deadline, contracts);
      try { await client.call({ account: creator, to: tx.to, data: tx.data, value: tx.value }); }
      catch (error) {
        const trace = await fork.rpcCall("debug_traceCall", [
          { from: creator, to: tx.to, data: tx.data, value: toHex(tx.value) }, "latest",
          { tracer: "callTracer" },
        ]);
        await writeFile(".cache/robinhood-swap-failure-trace.json", JSON.stringify({ ticker, side, tx,
          poolKey: state.poolKey, quote, trace }, (_, value) => typeof value === "bigint" ? String(value) : value, 2));
        throw error;
      }
      const receipt = await confirmed(await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }));
      return { hash: receipt.transactionHash, amountIn, quotedOut: quote.amountOut, minOut: tx.minOut };
    }
    const beforeBuy = await balance(asset.address, creator);
    const buy = await trade(asset.address, amount / 2n);
    assert.equal(beforeBuy - await balance(asset.address, creator), buy.amountIn);
    const bought = await balance(registered.address, creator);
    assert(bought >= buy.minOut);
    const beforeSell = await balance(asset.address, creator);
    const sell = await trade(registered.address, bought / 2n);
    const quoteReturned = await balance(asset.address, creator) - beforeSell;
    assert(quoteReturned >= sell.minOut);
    assert.equal(bought - await balance(registered.address, creator), sell.amountIn);
    const claimData = encodeFunctionData({ abi: claimFeesAbi, functionName: "collectFees", args: [registered.poolId] });
    const assetIs0 = sameAddress(state.poolKey.currency0, asset.address);
    const ordered = (fees: { fees0: bigint; fees1: bigint }) => assetIs0
      ? [fees.fees0, fees.fees1] : [fees.fees1, fees.fees0];
    const payouts = [];
    for (const [account, signer] of [[creator, wallet], [treasury, treasuryWallet]] as const) {
      const preview = await service.fees(registered.address, account);
      let totalQuote = 0n;
      for (const [kind, contract, fees] of [["hook", contracts.rehype, preview.trade],
        ["LP", contracts.initializer, preview.lp]] as const) {
        const before = await Promise.all([balance(asset.address, account), balance(registered.address, account)]);
        await client.call({ account, to: contract, data: claimData });
        // MUSEGOD's transfer callback performs additional oracle/state reads.
        // A traced local receipt exhausted nested-call gas at Anvil's exact
        // estimate. Keep a measured margin; contract balances/claims still
        // must match the preview exactly, without modifying token state.
        const estimatedGas = await client.estimateGas({ account, to: contract, data: claimData });
        const gasLimit = estimatedGas * 125n / 100n;
        const receipt = await confirmed(await signer.sendTransaction({ to: contract, data: claimData, gas: gasLimit }));
        const after: bigint[] = await Promise.all([balance(asset.address, account), balance(registered.address, account)]);
        const paid: bigint[] = after.map((amount: bigint, index: number) => amount - before[index]);
        assert.deepEqual(paid, ordered(fees), `${ticker} ${kind} preview must equal each raw currency payout`);
        totalQuote += paid[0];
        const allocation = account === treasury ? paid.map((amount) =>
          allocateFeeIncome({ feePolicy: FEE_POLICY, amount, account, creator, treasury })!) : undefined;
        if (allocation) for (const row of allocation) {
          assert.equal(row.buyback, row.platform * 80n / 100n);
          assert.equal(row.buyback + row.operations + row.remainder, row.platform);
        }
        payouts.push({ account, kind, hash: receipt.transactionHash, estimatedGas, gasLimit,
          gasUsed: receipt.gasUsed, currencies: [asset.symbol, registered.symbol], paid,
          platformAllocationReferenceOnly: allocation });
      }
      assert(totalQuote > 0n, `${ticker} beneficiary must actually receive quote fees`);
    }
    evidence.push({ asset, funding, tokenAddress: registered.address, poolId: registered.poolId,
      launchHash, feePolicy: registered.feePolicy, feeTreasury: registered.feeTreasury,
      openingValuation: registered.openingValuation,
      initialPoolPrice: { blockNumber: priceBlock, sqrtPriceX96, memeIs0, actualOpeningCapUsd },
      shares, buy, sell, bought, quoteReturned, payouts,
      checks: ["canonical creation", "registration and idempotency", "restart recovery",
        "buy and sell exact raw unit balances", "onchain beneficiary shares",
        "separate hook and LP claim preview/receipt/balance equality for creator and treasury"] });
    console.log(`PASS: ${ticker} ${asset.decimals}-decimal quote complete`);
  }
} finally {
  try {
    snapshotRestored = await fork.rpcCall("evm_revert", [snapshot]);
    assert.equal(snapshotRestored, true);
    await service.reconcile();
    for (const address of testedTokens)
      assert.equal(await service.store.token(address), null, "Reorganization removes orphaned issuance records");
    assert.equal(fork.blockedUpstreamWrites(), 0);
    await mkdir(".cache", { recursive: true });
    await writeFile(".cache/robinhood-fork-proof.json", JSON.stringify({
      scope: "Isolated Robinhood mainnet state fork; execution chain 31337 only. No mainnet signing or broadcast.",
      observedAt: new Date().toISOString(), upstreamChainId: 4663, executionChainId: 31337,
      forkBlockNumber: fork.blockNumber, snapshotRestored, blockedUpstreamWrites: fork.blockedUpstreamWrites(),
      fullFlowPassed: evidence.length === testedTickers.length, mainnetTransactionsSubmitted: false,
      curatedWhitelistPolicy: { excluded: ["U", "PAIR"], custom: ["MUSEGOD"] },
      representativeAssetsExpected: testedTickers,
      baseFeeBridgingExecuted: false, buybackOrBurnExecuted: false,
      gasModelScope: "EVM contract flow only; not Robinhood sequencer, L1 data fee, or finality acceptance",
      creator, treasury, contracts, assets: evidence,
    }, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n");
  } catch (error) { console.error(redact(error)); process.exitCode = 1; }
  await service.store.close();
  await rm(dataDir, { recursive: true, force: true });
  await fork.stop();
}
assert.equal(evidence.length, testedTickers.length, "All representative quote precisions, stock and custom asset flows must pass");
console.log(`PASS: Robinhood fork ${testedTickers.join(" / ")}; snapshots restored and no mainnet writes.`);
