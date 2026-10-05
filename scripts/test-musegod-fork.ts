import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData,
  erc20Abi, getContractAddress, http, keccak256, parseAbi, parseEther,
  type Address,
} from "viem";
import { robinhood } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { redact } from "../server/config";
import type { RuntimeConfig } from "../src/lib/config";
import { musegodSwapTransaction, type MusegodQuote } from "../src/lib/musegod";
import { minimumOutput } from "../src/lib/validation";
import { startRobinhoodFork } from "./robinhood-fork";

// Runtime/source acceptance is independent from enabling any production writes.
// Only the caller's release/acceptance process may activate production trading.
const TOKEN: Address = "0x0379E228F6887c6F18bf394042ECAF81B308cb2e";
const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const POOL: Address = "0x071eE139277688d64B139Af1e44f79a9acf12e53";
const FACTORY: Address = "0xE51960f1B45f1C9FB6D166E6a884F866fC70433B";
const QUOTER: Address = "0x3e290e5e01818002a0b672148bdc7514d861c7b3";
const ROUTER: Address = "0xb2d8ed81e79eb64a0751352459ec215fbafad669";
const ROUTER_CODE_HASH = "0xfc74a488f09061ac920441cff14bbda46c9202680572881ccd9e12ac019ee406";
const FACTORY_V2: Address = "0xE52abd50ad151ecDf56427effD715E703696a6B1";
const POSITION_MANAGER: Address = "0x51d0e5188afe12d502e29D982d20C190e7816107";
const POOL_INIT_CODE_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
const ARTIFACT_URL = "https://unpkg.com/@uniswap/swap-router-contracts@1.3.1/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json";
const ARTIFACT_SHA256 = "210a7bf29f26de9f45d35dac1214943eca41c3a002007dd6a0e1aa870bf2d2d1";
// Exact compiler immutableReferences from official commit 550c0f2, reproduced
// with solc 0.7.6, Istanbul, 1,000,000 optimizer runs, metadata.bytecodeHash=none.
// These are compiler offsets, not a wildcard mask over differences.
const immutableReferences = {
  factory: { address: FACTORY, astId: 53, offsets: [7756, 9439, 15579] },
  WETH9: { address: WETH, astId: 57, offsets: [705, 2876, 4781, 5079, 5246, 5807, 6105, 11663, 11759, 11888] },
  factoryV2: { address: FACTORY_V2, astId: 2191, offsets: [3170, 3382, 4066, 5707, 12226, 12677] },
  positionManager: { address: POSITION_MANAGER, astId: 2195, offsets: [5743, 6938, 7836, 12966] },
} as const;
const FEE = 10_000;
const routerAbi = parseAbi([
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function factoryV2() view returns (address)",
  "function positionManager() view returns (address)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function refundETH() payable",
]);
const quoterAbi = parseAbi([
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const poolAbi = parseAbi([
  "function token0() view returns (address)", "function token1() view returns (address)",
  "function factory() view returns (address)", "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
]);
const fork = await startRobinhoodFork(process.env.ROBINHOOD_RPC_URL?.trim()
  || "https://rpc.mainnet.chain.robinhood.com");
const chain = { ...robinhood, id: 31337, name: "Isolated MUSEGOD candidate fork" };
const client = createPublicClient({ chain, transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }) });
// Common Anvil addresses already have delegated code on this chain. Use a
// fresh ephemeral EOA instead of clearing any inherited code. Its secret never
// leaves this process; its wallet transport can only reach the chain-31337 fork.
const account = privateKeyToAccount(generatePrivateKey());
const trader: Address = account.address;
assert.equal(new URL(fork.rpc).hostname, "127.0.0.1");
assert.equal(await client.getChainId(), 31337);
const traderCode = await client.getCode({ address: trader });
assert(!traderCode || traderCode === "0x");
await fork.rpcCall("anvil_setBalance", [trader, "0x8ac7230489e80000"]); // 10 local-only ETH.
const wallet = createWalletClient({ chain, account, transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }) });
const localConfig: RuntimeConfig = { mode: "fork", chainId: 31337, deploymentChainId: 4663,
  treasury: null, writesEnabled: true, blockReason: null };
const snapshot = await fork.rpcCall("evm_snapshot");
const evidence: Record<string, unknown> = {
  status: "not_run", observedAt: new Date().toISOString(),
  scope: "Candidate router execution on an isolated Robinhood mainnet-state fork only; no mainnet signing or broadcast.",
  upstreamChainId: 4663, executionChainId: 31337, forkBlockNumber: fork.blockNumber,
  mainnetTransactionsSubmitted: false, productionTradingEnabled: false,
  sourceVerification: {
    verified: false, router: ROUTER, runtimeCodeHash: ROUTER_CODE_HASH,
    reason: "Executable runtime equality has not yet been checked by this run.",
    metadataIpfsCid: "QmUYDPaLfoLV6Qo2rp935eTCuhyB4bRPo6b5ad4Cod9TB5",
    factoryQuoterAndPoolInitHashSource: "https://github.com/sushi-labs/sushi/blob/437f84c336be71e0bb0ec58bd53a5ed941d3536e/src/evm/config/features/sushiswap-v3.ts",
    poolInitCodeHash: POOL_INIT_CODE_HASH,
  },
  contracts: { token: TOKEN, weth: WETH, pool: POOL, factory: FACTORY, quoter: QUOTER, candidateRouter: ROUTER },
  abi: "SwapRouter02 seven-field exactInputSingle; deadline supplied to multicall(uint256,bytes[]).",
  gasModelScope: "Local EVM execution only; not Robinhood sequencer, L1 data fee, or finality acceptance.",
  trader, traderCode: "0x", funding: "10 native ETH funded with anvil_setBalance on loopback chain 31337 only; pool/token/code unmodified.", tests: [],
};
const tests = evidence.tests as Record<string, unknown>[];
let stage = "identity";
const tokenBalance = (token: Address, account: Address) => client.readContract({
  address: token, abi: erc20Abi, functionName: "balanceOf", args: [account],
});
const balances = async () => ({
  native: BigInt(await fork.rpcCall("eth_getBalance", [trader, "latest"])),
  token: await tokenBalance(TOKEN, trader), weth: await tokenBalance(WETH, trader),
  routerNative: BigInt(await fork.rpcCall("eth_getBalance", [ROUTER, "latest"])),
  routerToken: await tokenBalance(TOKEN, ROUTER), routerWeth: await tokenBalance(WETH, ROUTER),
});
const allowance = () => client.readContract({ address: TOKEN, abi: erc20Abi,
  functionName: "allowance", args: [trader, ROUTER] });
const slot0 = () => client.readContract({ address: POOL, abi: poolAbi, functionName: "slot0" });
async function verifySourceRuntime(runtime: `0x${string}`) {
  const response = await fetch(ARTIFACT_URL, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok, "Pinned official Uniswap Router artifact must be available");
  const raw = await response.text();
  assert.equal(createHash("sha256").update(raw).digest("hex"), ARTIFACT_SHA256,
    "Official version-pinned artifact must have the reviewed SHA-256");
  const artifact = JSON.parse(raw) as { deployedBytecode: string; abi: { name?: string }[] };
  const compiledHex = artifact.deployedBytecode.slice(2).toLowerCase();
  let reconstructed = compiledHex;
  for (const [name, reference] of Object.entries(immutableReferences)) {
    const actual = await client.readContract({ address: ROUTER, abi: routerAbi,
      functionName: name as keyof typeof immutableReferences });
    assert.equal(actual.toLowerCase(), reference.address.toLowerCase(), "Each immutable must match official Sushi configuration");
    for (const start of reference.offsets) {
      assert.equal(reconstructed.slice(start * 2, (start + 32) * 2), "0".repeat(64),
        "Only compiler-declared zero immutable placeholders may be filled");
      reconstructed = reconstructed.slice(0, start * 2) + reference.address.slice(2).toLowerCase().padStart(64, "0")
        + reconstructed.slice((start + 32) * 2);
    }
  }
  const stripCompilerMetadata = (hex: string, expectedLength: number) => {
    assert.match(hex, /^[0-9a-f]+$/);
    const cborLength = Number.parseInt(hex.slice(-4), 16);
    assert.equal(cborLength, expectedLength);
    const cut = hex.length - 4 - cborLength * 2;
    assert.equal(hex.slice(cut - 2, cut), "fe", "Compiler CBOR must follow its INVALID opcode");
    return hex.slice(0, cut);
  };
  const officialBody = stripCompilerMetadata(reconstructed, 10);
  const deployedBody = stripCompilerMetadata(runtime.slice(2).toLowerCase(), 51);
  assert.equal(deployedBody, officialBody, "All executable EVM bytes must equal the immutable-filled official artifact");
  assert.equal(deployedBody.length / 2, 24485);
  for (const name of ["owner", "admin", "implementation", "upgradeTo", "setFactory", "setWETH9"])
    assert(!artifact.abi.some((entry) => entry.name === name), "Matched implementation has no proxy/admin entrypoint");
  return {
    verified: true, executableRuntimeEquivalent: true, officialSushiRouterAddressDeclarationFound: false,
    sourcePackage: "@uniswap/swap-router-contracts@1.3.1", sourceCommit: "550c0f20373a487996fcc957075377b67af9df07",
    sourceUrl: "https://github.com/Uniswap/swap-router-contracts/tree/550c0f20373a487996fcc957075377b67af9df07",
    artifactUrl: ARTIFACT_URL, artifactSha256: ARTIFACT_SHA256,
    compiler: "0.7.6+commit.7338295f", compilerSettings: { evmVersion: "istanbul", optimizerRuns: 1_000_000, bytecodeHash: "none" },
    immutableReferences, immutableReferenceCount: 23,
    executableBodyBytes: 24485, runtimeBytes: (runtime.length - 2) / 2, artifactBytes: compiledHex.length / 2,
    compilerMetadataBytesIncludingFooter: { candidate: 53, officialArtifact: 12 },
    metadataRule: "Remove only final uint16-declared CBOR bytes plus the 2-byte footer; require preceding INVALID (0xfe).",
    allExecutableDifferencesExplained: true, metadataContentCorrespondenceVerified: false,
    proxyOrMutableAdminEntrypointPresent: false,
    compiledStorageLayout: [{ slot: "0", offset: 0, label: "amountInCached", type: "uint256" }],
    reason: "All executable bytes exactly match official compiled SwapRouter02 after compiler-defined immutable substitution; metadata differs.",
    sushiConfigSource: "https://github.com/sushi-labs/sushi/tree/437f84c336be71e0bb0ec58bd53a5ed941d3536e/src/evm/config/features",
    dependencies: { "@uniswap/v2-core": "1.0.1", "@uniswap/v3-core": "1.0.0",
      "@uniswap/v3-periphery": "1.4.4", "@openzeppelin/contracts": "3.4.2-solc-0.7" },
  };
}
const quote = async (tokenIn: Address, tokenOut: Address, amountIn: bigint) =>
  (await client.simulateContract({ address: QUOTER, abi: quoterAbi,
    functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee: FEE, sqrtPriceLimitX96: 0n }],
  })).result[0];
function swapData(tokenIn: Address, tokenOut: Address, amountIn: bigint, minOut: bigint, recipient: Address) {
  return encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle",
    args: [{ tokenIn, tokenOut, fee: FEE, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
}
function buyData(amountIn: bigint, minOut: bigint, deadline: bigint) {
  return encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [deadline, [
    swapData(WETH, TOKEN, amountIn, minOut, trader),
    encodeFunctionData({ abi: routerAbi, functionName: "refundETH" }),
  ]] });
}
function sellData(amountIn: bigint, minOut: bigint, deadline: bigint) {
  return encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [deadline, [
    swapData(TOKEN, WETH, amountIn, minOut, ROUTER),
    encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [minOut, trader] }),
  ]] });
}
async function appTransaction(side: "buy" | "sell", amountIn: bigint, amountOut: bigint) {
  const block = await client.getBlock();
  assert(block.number !== null && block.hash !== null);
  const deadline = block.timestamp + 300n;
  const expiresAt = Number(deadline * 1000n), quotedAt = expiresAt - 60_000;
  const minOut = minimumOutput(amountOut, 100);
  const appQuote: MusegodQuote = { protocol: "sushi-v3", chainId: 31337, deploymentChainId: 4663,
    token: TOKEN, poolAddress: POOL, side, amountIn: amountIn.toString(), amountOut: amountOut.toString(),
    minAmountOut: minOut.toString(), slippageBps: 100, quotedAt, expiresAt,
    blockNumber: block.number.toString(), blockHash: block.hash };
  // Exercise the production pure builder with an explicit local quote clock.
  // Chain time supplies the on-chain deadline; host time cannot fake expiry.
  const transaction = musegodSwapTransaction(appQuote, trader, localConfig, quotedAt);
  assert.equal(transaction.to.toLowerCase(), ROUTER.toLowerCase());
  assert.equal(transaction.value, side === "buy" ? amountIn : 0n);
  assert.equal(transaction.data, side === "buy"
    ? buyData(amountIn, minOut, deadline) : sellData(amountIn, minOut, deadline),
  "Actual app builder must exactly match independently constructed SwapRouter02 calldata");
  return { transaction, appQuote, deadline, minOut };
}
async function send(to: Address, data: `0x${string}`, value = 0n) {
  assert.equal(new URL(fork.rpc).hostname, "127.0.0.1");
  assert.equal(await client.getChainId(), 31337, "Every write is restricted to the loopback fork");
  const hash = await wallet.sendTransaction({ to, data, value, gas: 1_500_000n });
  await fork.rpcCall("anvil_mine", [2]);
  return client.waitForTransactionReceipt({ hash });
}
async function expectRevert(name: string, data: `0x${string}`, value: bigint) {
  const before = await balances(), poolBefore = await slot0(), approvalBefore = await allowance();
  const receipt = await send(ROUTER, data, value);
  assert.equal(receipt.status, "reverted", `${name} must revert on the fork`);
  const after = await balances();
  assert.equal(before.native - after.native, receipt.gasUsed * receipt.effectiveGasPrice,
    `${name} may charge local gas only`);
  assert.deepEqual({ ...after, native: before.native }, before, `${name} must preserve every asset balance`);
  assert.deepEqual(await slot0(), poolBefore, `${name} must roll back the pool swap`);
  assert.equal(await allowance(), approvalBefore, `${name} must preserve allowance`);
  tests.push({ name, passed: true, hash: receipt.transactionHash, gasUsed: receipt.gasUsed,
    assetBalancesAndPoolRolledBack: true });
}
let initial: Awaited<ReturnType<typeof balances>> | undefined;
let initialSlot0: Awaited<ReturnType<typeof slot0>> | undefined;
try {
  assert.equal(await client.getChainId(), 31337);
  assert.equal(await fork.upstream.getChainId(), 4663);
  const block = await client.getBlock({ blockNumber: fork.blockNumber });
  evidence.forkBlockHash = block.hash;
  evidence.forkBlockTimestamp = block.timestamp;
  const [token0, token1, factory, fee, liquidity, routerFactory, routerWeth, quoterFactory, quoterWeth] = await Promise.all([
    client.readContract({ address: POOL, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: POOL, abi: poolAbi, functionName: "token1" }),
    client.readContract({ address: POOL, abi: poolAbi, functionName: "factory" }),
    client.readContract({ address: POOL, abi: poolAbi, functionName: "fee" }),
    client.readContract({ address: POOL, abi: poolAbi, functionName: "liquidity" }),
    client.readContract({ address: ROUTER, abi: routerAbi, functionName: "factory" }),
    client.readContract({ address: ROUTER, abi: routerAbi, functionName: "WETH9" }),
    client.readContract({ address: QUOTER, abi: quoterAbi, functionName: "factory" }),
    client.readContract({ address: QUOTER, abi: quoterAbi, functionName: "WETH9" }),
  ]);
  assert.equal(token0.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(token1.toLowerCase(), WETH.toLowerCase());
  for (const address of [factory, routerFactory, quoterFactory]) assert.equal(address.toLowerCase(), FACTORY.toLowerCase());
  for (const address of [routerWeth, quoterWeth]) assert.equal(address.toLowerCase(), WETH.toLowerCase());
  assert.equal(fee, FEE);
  assert(liquidity > 0n);
  const canonical = await client.readContract({ address: FACTORY,
    abi: parseAbi(["function getPool(address,address,uint24) view returns(address)"]),
    functionName: "getPool", args: [TOKEN, WETH, FEE] });
  assert.equal(canonical.toLowerCase(), POOL.toLowerCase());
  const derived = getContractAddress({ opcode: "CREATE2", from: FACTORY, bytecodeHash: POOL_INIT_CODE_HASH,
    salt: keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], [TOKEN, WETH, FEE])) });
  assert.equal(derived.toLowerCase(), POOL.toLowerCase(), "Pool must match the official Sushi init code hash");
  const codes: Record<string, unknown> = {};
  for (const [name, address] of Object.entries({ router: ROUTER, pool: POOL, factory: FACTORY, quoter: QUOTER })) {
    const code = await client.getCode({ address });
    assert(code && code !== "0x");
    codes[name] = { bytes: (code.length - 2) / 2, hash: keccak256(code) };
    if (name === "router") {
      assert.equal(keccak256(code), ROUTER_CODE_HASH, "Candidate runtime must remain pinned");
      evidence.sourceVerification = { ...(evidence.sourceVerification as Record<string, unknown>),
        ...await verifySourceRuntime(code) };
    }
  }
  evidence.identity = { verifiedPoolAndQuoter: true, candidateRouterSourceVerified: true,
    poolInitCodeHashMatched: true, fee, liquidity, codes };
  initial = await balances();
  initialSlot0 = await slot0();
  assert(initialSlot0[6], "Pool must be unlocked");
  assert.equal(initial.routerNative, 0n, "Candidate router must start without native dust");
  assert.equal(initial.routerToken, 0n, "Candidate router must start without token dust");
  assert.equal(initial.routerWeth, 0n, "Candidate router must start without WETH dust");
  assert.equal(await allowance(), 0n, "Fresh local trader must start without allowance");
  evidence.initialBalances = initial;
  console.log("MUSEGOD fork: pool identity and pinned candidate runtime passed; testing native buy");
  const amountIn = parseEther("0.001");
  stage = "buy minOut and deadline failures";
  const buyQuote = await quote(WETH, TOKEN, amountIn);
  assert(buyQuote > 0n);
  const now = (await client.getBlock()).timestamp;
  await expectRevert("buy minOut", buyData(amountIn, buyQuote * 2n, now + 300n), amountIn);
  await expectRevert("buy expired deadline", buyData(amountIn, 1n, now - 1n), amountIn);
  stage = "ETH buy and refund";
  const beforeBuy = await balances();
  const freshBuyQuote = await quote(WETH, TOKEN, amountIn);
  const buyApp = await appTransaction("buy", amountIn, freshBuyQuote), buyMinOut = buyApp.minOut;
  const extraNative = parseEther("0.000001");
  const buyReceipt = await send(buyApp.transaction.to, buyApp.transaction.data, buyApp.transaction.value + extraNative);
  assert.equal(buyReceipt.status, "success");
  const afterBuy = await balances(), bought = afterBuy.token - beforeBuy.token;
  const rawBuyReceipt = await fork.rpcCall("eth_getTransactionReceipt", [buyReceipt.transactionHash]);
  const buyTrace = await fork.rpcCall("debug_traceTransaction", [buyReceipt.transactionHash, { tracer: "callTracer" }]);
  const nativeTransfers: unknown[] = [];
  const collectNative = (call: any) => {
    if (call.type === "CALL" && BigInt(call.value || "0x0") > 0n) nativeTransfers.push({ from: call.from, to: call.to,
      value: BigInt(call.value), type: call.type, error: call.error });
    for (const child of call.calls ?? []) collectNative(child);
  };
  collectNative(buyTrace);
  evidence.buyBalanceAccounting = { before: beforeBuy, after: afterBuy, amountIn, extraNative,
    gasUsed: buyReceipt.gasUsed, effectiveGasPrice: buyReceipt.effectiveGasPrice, hash: buyReceipt.transactionHash,
    rawReceipt: rawBuyReceipt, nativeTransfers, quotedOut: freshBuyQuote };
  assert(bought >= buyMinOut);
  assert.equal(beforeBuy.native - afterBuy.native, amountIn + buyReceipt.gasUsed * buyReceipt.effectiveGasPrice,
    "Overpaid ETH must be refunded in the same buy transaction");
  assert.equal(afterBuy.weth, beforeBuy.weth, "Buyer must receive MUSEGOD without a WETH remainder");
  assert.equal(await allowance(), 0n, "Native buy must require no ERC20 allowance");
  assert.deepEqual([afterBuy.routerNative, afterBuy.routerToken, afterBuy.routerWeth], [0n, 0n, 0n]);
  tests.push({ name: "native ETH buy and atomic refund", passed: true, hash: buyReceipt.transactionHash,
    amountIn, quotedOut: freshBuyQuote, minimumOut: buyMinOut, actualTokenReceived: bought,
    overpaymentRefunded: extraNative, gasUsed: buyReceipt.gasUsed, gasCost: buyReceipt.gasUsed * buyReceipt.effectiveGasPrice,
    appBuilder: "musegodSwapTransaction", appQuote: buyApp.appQuote,
    appBuilderCalldataMatchesIndependentAbi: true, appCalldataHash: keccak256(buyApp.transaction.data) });
  console.log("MUSEGOD fork: native buy, refund, minOut and deadline passed; testing token sell");
  stage = "exact MUSEGOD approval";
  const approvalReceipt = await send(TOKEN, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, bought] }));
  assert.equal(approvalReceipt.status, "success");
  assert.equal(await allowance(), bought, "Approval must match the exact amount to sell");
  tests.push({ name: "exact token approval", passed: true, hash: approvalReceipt.transactionHash, amount: bought });
  stage = "sell minOut and deadline failures";
  const sellQuote = await quote(TOKEN, WETH, bought), sellNow = (await client.getBlock()).timestamp;
  assert(sellQuote > 0n);
  await expectRevert("sell minOut", sellData(bought, sellQuote * 2n, sellNow + 300n), 0n);
  await expectRevert("sell expired deadline", sellData(bought, 1n, sellNow - 1n), 0n);
  stage = "sell and atomic ETH unwrap";
  const beforeSell = await balances(), freshSellQuote = await quote(TOKEN, WETH, bought);
  const sellApp = await appTransaction("sell", bought, freshSellQuote), sellMinOut = sellApp.minOut;
  const sellReceipt = await send(sellApp.transaction.to, sellApp.transaction.data, sellApp.transaction.value);
  assert.equal(sellReceipt.status, "success");
  const afterSell = await balances();
  const actualNativeReceived = afterSell.native - beforeSell.native + sellReceipt.gasUsed * sellReceipt.effectiveGasPrice;
  assert(actualNativeReceived >= sellMinOut);
  assert.equal(beforeSell.token - afterSell.token, bought, "Sell must spend the exact approved token amount");
  assert.equal(afterSell.token, initial.token);
  assert.equal(afterSell.weth, initial.weth, "Sell output must reach the wallet as ETH");
  assert.equal(await allowance(), 0n, "Exact approval must be consumed entirely");
  assert.deepEqual([afterSell.routerNative, afterSell.routerToken, afterSell.routerWeth], [0n, 0n, 0n]);
  evidence.finalBalances = afterSell;
  tests.push({ name: "sell with atomic ETH unwrap and no residue", passed: true, hash: sellReceipt.transactionHash,
    amountIn: bought, quotedOut: freshSellQuote, minimumOut: sellMinOut, actualNativeReceived,
    gasUsed: sellReceipt.gasUsed, gasCost: sellReceipt.gasUsed * sellReceipt.effectiveGasPrice,
    allowanceRemaining: 0n, routerNativeRemaining: 0n, routerWethRemaining: 0n, routerTokenRemaining: 0n,
    appBuilder: "musegodSwapTransaction", appQuote: sellApp.appQuote,
    appBuilderCalldataMatchesIndependentAbi: true, appCalldataHash: keccak256(sellApp.transaction.data) });
  evidence.status = "passed";
  evidence.candidateExecutionVerifiedOnFork = true;
  evidence.actualAppBuilderExecutionVerifiedOnFork = true;
} catch (error) {
  evidence.status = "failed";
  evidence.failedStage = stage;
  evidence.error = redact(error);
  process.exitCode = 1;
} finally {
  try {
    const restored = await fork.rpcCall("evm_revert", [snapshot]);
    assert.equal(restored, true);
    if (initial) assert.deepEqual(await balances(), initial, "Snapshot must restore every original asset balance");
    if (initialSlot0) assert.deepEqual(await slot0(), initialSlot0, "Snapshot must restore original pool state");
    assert.equal(fork.blockedUpstreamWrites(), 0);
    evidence.snapshotRestored = true;
    evidence.blockedUpstreamWrites = fork.blockedUpstreamWrites();
  } catch (error) {
    evidence.status = "failed";
    evidence.cleanupError = redact(error);
    process.exitCode = 1;
  }
  await fork.stop();
  await mkdir("docs/evidence", { recursive: true });
  await writeFile("docs/evidence/musegod-fork.json", JSON.stringify(evidence,
    (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n");
}
console.log(`${evidence.status === "passed" ? "PASS" : "FAIL"}: MUSEGOD fork; production trading stays disabled.`);
