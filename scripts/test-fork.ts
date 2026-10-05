import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  encodeFunctionData,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  parseAbiItem,
  parseAbi,
  zeroAddress,
  toHex,
  type Address,
  type Hash,
} from "viem";
import { base } from "viem/chains";
import { DopplerSDK, airlockAbi } from "@whetstone-research/doppler-sdk/evm";
import {
  CONTRACTS,
  STOCKS,
  SUPPLY,
  WAD,
  sameAddress,
  poolCurrency,
} from "../src/lib/config";
import {
  assertStock,
  claimFeesAbi,
  permit2Abi,
  swapTransaction,
} from "../src/lib/protocol";
import { LaunchpadService } from "../server/service";
import { allocateFeeIncome, FEE_POLICY, MUSEGOD_BUYBACK } from "../src/lib/fee-policy";

const rpc = process.env.FORK_RPC_URL || "http://127.0.0.1:8547";
const url = new URL(rpc);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Fork writes require loopback",
);
async function rpcCall(method: string, params: unknown[] = []) {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
assert.equal(
  await rpcCall("eth_chainId"),
  "0x7a69",
  "Fork writes require chain 31337",
);
assert.match(
  await rpcCall("web3_clientVersion"),
  /anvil/i,
  "Fork writes require Anvil",
);
const nodeInfo = await rpcCall("anvil_nodeInfo");
assert(
  nodeInfo.forkConfig?.forkUrl,
  "A Base fork is required, not an empty Anvil",
);
const forkChain = { ...base, id: 31337, name: "Base fork" };
const client = createPublicClient({
  chain: base,
  transport: http(rpc, { timeout: 180_000, retryCount: 0 }),
});
const accounts: Address[] = await rpcCall("eth_accounts");
const creator = accounts[0],
  treasury = accounts[1];
const wallet = createWalletClient({
  chain: forkChain,
  account: creator,
  transport: http(rpc),
});
const sdkClient = client.extend(() => ({ getChainId: async () => 8453 }));
const sdk = new DopplerSDK<8453>({
  publicClient: sdkClient,
  walletClient: wallet,
  chainId: 8453,
});
const stock = STOCKS.find(
  (s) => s.ticker === (process.env.TEST_STOCK || "NVDA"),
)!;
assert(stock, "Test stock must be whitelisted");
const nativeStock = await assertStock(client, stock.address);
assert.equal(
  nativeStock.stock.decimals,
  8,
  "Requires Base-native B20 dispatch, not stock Anvil",
);
const stockAmount = (amount: string) => parseUnits(amount, stock.decimals);
let service = new LaunchpadService({
  config: {
    mode: "fork",
    chainId: 31337,
    treasury,
    writesEnabled: true,
    blockReason: null,
  },
  rpcUrl: rpc,
  dataDir: await mkdtemp(join(tmpdir(), "musegod-fork-")),
});
const snapshot = await rpcCall("evm_snapshot");
let testedAddress: Address | undefined;
let feeEvidence: Record<string, unknown> | undefined;
try {
  console.log(
    `Fork confirmed; creating ${stock.symbol}-paired token with canonical modules`,
  );
  const plan = await service.prepare(
    {
      name: "Stock Fork Proof",
      symbol: "LFPROOF",
      description:
        "本地 Base 分叉验证资产。创建、买卖和费用领取使用真实合约；无主网交易。",
      image: "",
      quoteAddress: stock.address,
      openingCap: "100",
    },
    creator,
  );
  assert.equal(plan.feePolicy, FEE_POLICY);
  assert(sameAddress(plan.feeTreasury!, treasury));
  assert.deepEqual(await service.validateLaunch(creator, plan.data), {
    valid: true,
    feePolicy: FEE_POLICY,
  });
  console.log("Launch simulation passed", plan.tokenAddress);
  const launchHash = await wallet.sendTransaction({
    to: CONTRACTS.airlock,
    data: plan.data,
    value: 0n,
  });
  await service.trackLaunch(launchHash, plan.id);
  const savedRuntime = service.runtime;
  await service.store.close();
  service = new LaunchpadService(savedRuntime);
  service.runtime.config.writesEnabled = false;
  await rpcCall("anvil_mine", [2]);
  await service.reconcile();
  assert.equal(
    (await service.store.token(plan.tokenAddress))?.address,
    plan.tokenAddress,
    "Restart recovery must register a submitted launch even after signing is disabled",
  );
  service.runtime.config.writesEnabled = true;
  testedAddress = plan.tokenAddress;
  const receipt = await client.waitForTransactionReceipt({
    hash: launchHash,
    confirmations: 2,
  });
  assert.equal(receipt.status, "success");
  const registered = await service.register(receipt.transactionHash);
  assert.equal(registered.address, plan.tokenAddress);
  assert.equal(registered.feePolicy, FEE_POLICY);
  assert(sameAddress(registered.feeTreasury!, treasury));
  assert.equal(
    (await service.register(receipt.transactionHash)).address,
    registered.address,
    "Registration must be idempotent",
  );
  const result = {
    tokenAddress: registered.address,
    poolId: registered.poolId,
    transactionHash: registered.transactionHash,
  };
  console.log("Launch executed", result.tokenAddress);
  const pool = await sdk.getMulticurvePool(result.tokenAddress);
  const state = await pool.getState();
  assert.equal(state.status, 2);
  const protocolOwner = await sdk.getAirlockOwner();
  assert(!sameAddress(protocolOwner, creator) && !sameAddress(protocolOwner, treasury));
  const sharesAbi = parseAbi([
    "function getShares(bytes32 poolId, address beneficiary) view returns (uint256)",
  ]);
  const readShares = (contract: Address, beneficiary: Address) =>
    client.readContract({ address: contract, abi: sharesAbi, functionName: "getShares", args: [registered.poolId, beneficiary] });
  const [lpProtocol, lpCreator, lpPlatform, hookCreator, hookPlatform] = await Promise.all([
    readShares(CONTRACTS.initializer, protocolOwner),
    readShares(CONTRACTS.initializer, creator),
    readShares(CONTRACTS.initializer, treasury),
    readShares(CONTRACTS.rehype, creator),
    readShares(CONTRACTS.rehype, treasury),
  ]);
  assert.deepEqual([lpProtocol, lpCreator, lpPlatform], [WAD * 5n / 100n, WAD * 665n / 1000n, WAD * 285n / 1000n], "LP contract must allocate 5% Doppler, 66.5% creator and 28.5% platform");
  assert.deepEqual([hookCreator, hookPlatform], [WAD * 70n / 100n, WAD * 30n / 100n], "Hook beneficiary shares must split net fees 70/30 after protocol fees");
  const feeShares = { lp: { protocol: lpProtocol, creator: lpCreator, platform: lpPlatform }, hookNet: { creator: hookCreator, platform: hookPlatform } };
  assert(sameAddress(state.numeraire, stock.address));
  assert.equal(
    state.poolKey.fee,
    8388608,
    "Rehype PoolKey uses the dynamic fee flag, not the 500 LP fee",
  );
  assert.equal(
    (await service.state(result.tokenAddress)).token.poolId,
    plan.poolId,
  );
  assert.equal(
    await client.readContract({
      address: result.tokenAddress,
      abi: erc20Abi,
      functionName: "totalSupply",
    }),
    SUPPLY,
  );
  const data = await client.readContract({
    address: CONTRACTS.airlock,
    abi: airlockAbi,
    functionName: "getAssetData",
    args: [result.tokenAddress],
  });
  assert(sameAddress(data[9], treasury));
  assert(sameAddress(data[4], CONTRACTS.initializer));
  await mkdir("docs/evidence", { recursive: true });
  await writeFile(
    `docs/evidence/fork-launch-${stock.ticker}.json`,
    JSON.stringify(
      {
        scope: "local fork only",
        nodeInfo: {
          ...nodeInfo,
          forkConfig: { ...nodeInfo.forkConfig, forkUrl: "[redacted]" },
        },
        creator,
        treasury,
        stock,
        result,
        state,
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );

  // Discover real holders from canonical Transfer logs, then verify balances at
  // the fork. No block-explorer availability or fabricated token balances needed.
  const upstream = createPublicClient({
    chain: base,
    transport: http(nodeInfo.forkConfig.forkUrl, {
      timeout: 30_000,
      retryCount: 1,
    }),
  });
  assert.equal(await upstream.getChainId(), 8453);
  const forkBlock = BigInt(nodeInfo.forkConfig.forkBlockNumber);
  let donor: Address | undefined;
  try {
    const previous = JSON.parse(await readFile(`docs/evidence/fork-flow-${stock.ticker}.json`, "utf8"));
    const candidate = previous.donor as Address;
    const [balance, code] = await Promise.all([
      client.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [candidate] }),
      client.getCode({ address: candidate }),
    ]);
    if (balance > stockAmount("0.02") && (!code || code === "0x" || /^0xef0100[0-9a-fA-F]{40}$/.test(code))) donor = candidate;
  } catch { /* Prior evidence is only a hint; discover a current holder if unavailable. */ }
  const visited=new Set<string>();
  // Search recent transfers in bounded chunks; stop at the first funded EOA.
  // Small real amounts still exercise 8/18 decimal rounding and both fee streams.
  for(let window=0;window<100&&!donor;window++) {
    const end=forkBlock-BigInt(window)*10n;
    const transfers=await upstream.getLogs({address:stock.address,event:parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),fromBlock:end-9n,toBlock:end});
    const candidates=transfers.flatMap(l=>[l.args.to,l.args.from]).filter((a):a is Address=>!!a&&a!==zeroAddress);
    for(const candidate of candidates) {
      if(visited.has(candidate))continue;visited.add(candidate);
      const balance=await client.readContract({address:stock.address,abi:erc20Abi,functionName:'balanceOf',args:[candidate]});
      if(balance<=stockAmount('0.02'))continue;
      const code=await client.getCode({address:candidate});
      if(!code||code==='0x'||/^0xef0100[0-9a-fA-F]{40}$/.test(code)){donor=candidate;break;}
    }
  }
  assert(donor, "No funded stock EOA found for fork-only impersonation");
  const donorBalance = await client.readContract({
    address: stock.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [donor],
  });
  assert(donorBalance > stockAmount("0.02"));
  await rpcCall("anvil_impersonateAccount", [donor]);
  await rpcCall("anvil_setBalance", [donor, toHex(parseEther("1"))]);
  const donorWallet = createWalletClient({
    chain: forkChain,
    account: donor,
    transport: http(rpc),
  });
  async function confirmed(hash: Hash) {
    await rpcCall("anvil_mine", [2]);
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt;
  }
  await confirmed(
    await donorWallet.writeContract({
      address: stock.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [creator, stockAmount("0.02")],
    }),
  );
  await rpcCall("anvil_stopImpersonatingAccount", [donor]);
  async function trade(currencyIn: Address, amountIn: bigint) {
    const key = (await pool.getState()).poolKey;
    const quote = await service.quote(
      result.tokenAddress,
      sameAddress(currencyIn, stock.address) ? "buy" : "sell",
      formatUnits(amountIn, poolCurrency(currencyIn, registered).decimals),
      100,
    );
    const deadline = (await client.getBlock()).timestamp + 300n;
    const allowance = await client.readContract({
      address: currencyIn,
      abi: erc20Abi,
      functionName: "allowance",
      args: [creator, CONTRACTS.permit2],
    });
    // DopplerERC20V1 inherits Solady's fixed Permit2 allowance. Calling approve
    // with a finite amount would revert; the router-level Permit2 allowance is bounded.
    if (allowance < amountIn)
      await confirmed(
        await wallet.writeContract({
          address: currencyIn,
          abi: erc20Abi,
          functionName: "approve",
          args: [CONTRACTS.permit2, amountIn],
        }),
      );
    await confirmed(
      await wallet.writeContract({
        address: CONTRACTS.permit2,
        abi: permit2Abi,
        functionName: "approve",
        args: [currencyIn, CONTRACTS.router, amountIn, Number(deadline)],
      }),
    );
    const tx = swapTransaction(
      key,
      currencyIn,
      amountIn,
      BigInt(quote.amountOut),
      100,
      deadline,
    );
    await client.call({
      account: creator,
      to: tx.to,
      data: tx.data,
      value: 0n,
    });
    const receipt = await confirmed(
      await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n }),
    );
    return {
      hash: receipt.transactionHash,
      amountIn,
      quoteOut: quote.amountOut,
      minOut: tx.minOut,
    };
  }
  const stockBeforeBuy = await client.readContract({
    address: stock.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  const buy = await trade(stock.address, stockAmount("0.01"));
  const stockAfterBuy = await client.readContract({
    address: stock.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  assert.equal(
    stockBeforeBuy - stockAfterBuy,
    buy.amountIn,
    "Buy spends exactly the 8-decimal raw amount",
  );
  const bought = await client.readContract({
    address: result.tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  assert(bought >= buy.minOut);
  console.log("Buy passed", bought.toString());
  const beforeSell = await client.readContract({
    address: stock.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  const sell = await trade(result.tokenAddress, bought / 2n);
  const afterSell = await client.readContract({
    address: stock.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  const remainingMeme = await client.readContract({
    address: result.tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  assert.equal(
    bought - remainingMeme,
    sell.amountIn,
    "Sell spends exactly the 18-decimal raw amount",
  );
  assert(afterSell - beforeSell >= sell.minOut);
  console.log("Sell passed");
  const claimData = encodeFunctionData({
    abi: claimFeesAbi,
    functionName: "collectFees",
    args: [result.poolId],
  });
  const stockIs0 = sameAddress(stock.address, state.poolKey.currency0);
  const balancePair = async (account: Address) => Promise.all([
    client.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    client.readContract({ address: result.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
  ]);
  const orderedFees = (fees: { fees0: bigint; fees1: bigint }) => stockIs0 ? [fees.fees0, fees.fees1] : [fees.fees1, fees.fees0];
  const displayedFees = await service.fees(result.tokenAddress, creator);
  const creatorFeesBefore = await client.readContract({
    address: stock.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  const creatorMemeBefore = await client.readContract({
    address: result.tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  await client.call({
    account: creator,
    to: CONTRACTS.rehype,
    data: claimData,
  });
  const hookClaim = await confirmed(
    await wallet.sendTransaction({ to: CONTRACTS.rehype, data: claimData }),
  );
  const creatorAfterHook = await balancePair(creator);
  assert.deepEqual([creatorAfterHook[0] - creatorFeesBefore, creatorAfterHook[1] - creatorMemeBefore], orderedFees(displayedFees.trade), "Creator hook payout matches each currency's preview");
  await client.call({
    account: creator,
    to: CONTRACTS.initializer,
    data: claimData,
  });
  const lpClaim = await confirmed(
    await wallet.sendTransaction({
      to: CONTRACTS.initializer,
      data: claimData,
    }),
  );
  const creatorFeesAfter = await client.readContract({
    address: stock.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  assert(
    creatorFeesAfter > creatorFeesBefore,
    "Creator must receive stock-denominated fees",
  );
  const creatorMemePaid =
    (await client.readContract({
      address: result.tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [creator],
    })) - creatorMemeBefore;
  assert.deepEqual([creatorFeesAfter - creatorAfterHook[0], creatorMemeBefore + creatorMemePaid - creatorAfterHook[1]], orderedFees(displayedFees.lp), "Creator LP payout matches each currency's preview");
  assert.equal(
    creatorMemePaid,
    stockIs0
      ? displayedFees.lp.fees1 + displayedFees.trade.fees1
      : displayedFees.lp.fees0 + displayedFees.trade.fees0,
    "Creator meme fee display matches actual payout",
  );
  const displayedStockFees = stockIs0
    ? displayedFees.lp.fees0 + displayedFees.trade.fees0
    : displayedFees.lp.fees1 + displayedFees.trade.fees1;
  assert.equal(
    creatorFeesAfter - creatorFeesBefore,
    displayedStockFees,
    "Displayed fees must match the actual stock payout",
  );
  const treasuryWallet = createWalletClient({
    chain: forkChain,
    account: treasury,
    transport: http(rpc),
  });
  const treasuryBefore = await client.readContract({
    address: stock.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [treasury],
  });
  const treasuryDisplayed = await service.fees(result.tokenAddress, treasury);
  const treasuryMemeBefore = await client.readContract({
    address: result.tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [treasury],
  });
  const treasuryHookClaim = await confirmed(
    await treasuryWallet.sendTransaction({
      to: CONTRACTS.rehype,
      data: claimData,
    }),
  );
  const treasuryAfterHook = await balancePair(treasury);
  assert.deepEqual([treasuryAfterHook[0] - treasuryBefore, treasuryAfterHook[1] - treasuryMemeBefore], orderedFees(treasuryDisplayed.trade), "Platform hook payout matches each currency's preview");
  const treasuryLpClaim = await confirmed(
    await treasuryWallet.sendTransaction({
      to: CONTRACTS.initializer,
      data: claimData,
    }),
  );
  const treasuryPaid =
    (await client.readContract({
      address: stock.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [treasury],
    })) - treasuryBefore;
  assert(treasuryPaid > 0n, "Platform must receive stock-denominated fees");
  assert.equal(
    treasuryPaid,
    stockIs0
      ? treasuryDisplayed.lp.fees0 + treasuryDisplayed.trade.fees0
      : treasuryDisplayed.lp.fees1 + treasuryDisplayed.trade.fees1,
  );
  const treasuryMemePaid =
    (await client.readContract({
      address: result.tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [treasury],
    })) - treasuryMemeBefore;
  assert.deepEqual([treasuryBefore + treasuryPaid - treasuryAfterHook[0], treasuryMemeBefore + treasuryMemePaid - treasuryAfterHook[1]], orderedFees(treasuryDisplayed.lp), "Platform LP payout matches each currency's preview");
  assert.equal(
    treasuryMemePaid,
    stockIs0
      ? treasuryDisplayed.lp.fees1 + treasuryDisplayed.trade.fees1
      : treasuryDisplayed.lp.fees0 + treasuryDisplayed.trade.fees0,
    "Platform meme fee display matches actual payout",
  );
  // Match the UI's individual claim/currency rounding rather than rounding a
  // combined balance after hook and LP claims have already been received.
  const allocateClaim = (amount: bigint) => allocateFeeIncome({ feePolicy: FEE_POLICY, amount, account: treasury, creator, treasury })!;
  const perClaimAllocation = {
    hook: { stock: allocateClaim(orderedFees(treasuryDisplayed.trade)[0]), meme: allocateClaim(orderedFees(treasuryDisplayed.trade)[1]) },
    lp: { stock: allocateClaim(orderedFees(treasuryDisplayed.lp)[0]), meme: allocateClaim(orderedFees(treasuryDisplayed.lp)[1]) },
  };
  const sumClaims = (currency: "stock" | "meme") => {
    const hook = perClaimAllocation.hook[currency], lp = perClaimAllocation.lp[currency];
    return { creator: hook.creator + lp.creator, platform: hook.platform + lp.platform, buyback: hook.buyback + lp.buyback, operations: hook.operations + lp.operations, remainder: hook.remainder + lp.remainder };
  };
  const platformIncomeAllocation = {
    execution: "accounting_reference_only_no_transfer",
    basis: "per_claim_and_currency_then_sum_matching_UI",
    derivation: "Calculated from separately verified hook and LP raw payouts; not an onchain allocation transfer",
    perClaim: perClaimAllocation,
    stock: sumClaims("stock"),
    meme: sumClaims("meme"),
  };
  for (const claim of Object.values(perClaimAllocation)) for (const allocation of Object.values(claim)) {
    assert.equal(allocation.buyback, allocation.platform * 80n / 100n);
    assert.equal(allocation.operations, allocation.platform * 20n / 100n);
    assert.equal(allocation.buyback + allocation.operations + allocation.remainder, allocation.platform);
  }
  for (const [allocation, amount] of [[platformIncomeAllocation.stock, treasuryPaid], [platformIncomeAllocation.meme, treasuryMemePaid]] as const) {
    assert.equal(allocation.platform, amount);
    assert.equal(allocation.buyback + allocation.operations + allocation.remainder, amount);
  }
  // Leave a small, real fork fee balance for the browser's read-only display check.
  const previewBuy = await trade(stock.address, stockAmount("0.0001"));
  const previewFees = await service.fees(result.tokenAddress, creator);
  const evidence = {
    scope:
      "Base fork only; test accounts and impersonated donor; no mainnet writes",
    observedAt: new Date().toISOString(),
    forkBlock: nodeInfo.forkConfig.forkBlockNumber,
    creator,
    treasury,
    donor,
    stock,
    nativeStock,
    nodeVersion: await rpcCall("web3_clientVersion"),
    result,
    state,
    feePolicy: registered.feePolicy,
    feeTreasury: registered.feeTreasury,
    feeShares,
    buybackTarget: MUSEGOD_BUYBACK,
    crossChainBuybackExecuted: false,
    buy,
    bought,
    stockSpentOnBuy: stockBeforeBuy - stockAfterBuy,
    sell,
    stockFromSell: afterSell - beforeSell,
    hookClaim: hookClaim.transactionHash,
    lpClaim: lpClaim.transactionHash,
    displayedFees,
    creatorStockFees: creatorFeesAfter - creatorFeesBefore,
    treasuryStockFees: treasuryPaid,
    creatorMemeFees: creatorMemePaid,
    treasuryMemeFees: treasuryMemePaid,
    treasuryDisplayed,
    perStreamPayouts: {
      currencyOrder: [stock.symbol, registered.symbol],
      creatorHook: orderedFees(displayedFees.trade), creatorLp: orderedFees(displayedFees.lp),
      platformHook: orderedFees(treasuryDisplayed.trade), platformLp: orderedFees(treasuryDisplayed.lp),
    },
    platformIncomeAllocation,
    treasuryHookClaim: treasuryHookClaim.transactionHash,
    treasuryLpClaim: treasuryLpClaim.transactionHash,
    previewBuy,
    previewFees,
    checks: [
      "service prepare",
      "new plans and registered tokens preserve MuseGod fee policy and beneficiary",
      "onchain LP shares 5/66.5/28.5 and hook net shares 70/30",
      "predicted and actual pool identity",
      "receipt registration and idempotency",
      "verified pending tracking and server restart recovery after disabling new signatures",
      "service quote buy/sell",
      "creator displayed vs actual fees",
      "platform displayed vs actual fees",
      "separate hook and LP actual payouts for both beneficiaries and both currencies",
      "platform 80/20 reference rounded per claim and currency, summed with raw-unit conservation; no allocation transfer",
      "frontend claim calldata for both contracts",
      "native B20 precompile reads without code overrides",
      "8-decimal stock input and 18-decimal meme input balance deltas",
      "creator and platform stock AND meme fee balance deltas",
    ],
  };
  feeEvidence = evidence;
  await writeFile(
    `docs/evidence/fork-flow-${stock.ticker}.json`,
    JSON.stringify(
      evidence,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  console.log(
    "PASS: create → buy → sell → creator and platform fees; local fork only",
  );
} finally {
  assert.equal(
    await rpcCall("evm_revert", [snapshot]),
    true,
    "Fork snapshot must be restored",
  );
  await service.reconcile();
  if (testedAddress)
    assert.equal(
      await service.store.token(testedAddress),
      null,
      "Reorg must remove orphaned token",
    );
  await service.store.close();
  await rm(service.runtime.dataDir, { recursive: true, force: true });
  if (feeEvidence)
    await writeFile(
      "docs/evidence/fee-v2-fork.json",
      JSON.stringify({ ...feeEvidence, snapshotRestored: true }, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n",
    );
  console.log("Fork restored to pre-test snapshot.");
}
