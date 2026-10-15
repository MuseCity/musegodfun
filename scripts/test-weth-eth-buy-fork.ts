import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { DopplerSDK } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, decodeErrorResult, erc20Abi, getAddress, http, keccak256, parseEther, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { robinhood } from "viem/chains";
import { ROBINHOOD_CONTRACTS, sameAddress } from "../src/lib/config";
import { wrappedEther } from "../src/lib/first-buy-payment";
import { permit2Abi, wrapAndSwapTransaction } from "../src/lib/protocol";
import { feeSourceAbi, robinhoodUpstreamUrl, safeForkError } from "./nft-vault-fork-helpers";
import { startChainFork } from "./robinhood-fork";

// One read-only upstream session; only the isolated Anvil receives transactions. Never load the production environment.
const key = process.env.ALCHEMY_API_KEY ?? "", upstreamUrl = robinhoodUpstreamUrl(key);
const evidencePath = ".superpowers/sdd/eth-pay-auto-quote/evidence/fork-proof.json";
const sourcePath = ".superpowers/sdd/eth-pay-auto-quote/evidence/router-source/sourcify.json";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const evidence: Record<string, unknown> = { status: "running", stage: "initializing", observedAt: new Date().toISOString(),
  scope: "Robinhood mainnet state on isolated Anvil, execution chain 4663; fresh impersonated account; no mainnet transaction or wallet",
  runnerSha256: sha256(await readFile(new URL(import.meta.url), "utf8")), mainnetTransactionsSubmitted: false };
const upstreamMethods: Record<string, number> = {}, originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) === upstreamUrl && typeof init?.body === "string") {
    const parsed = JSON.parse(init.body);
    for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
      assert.notEqual(call.method, "eth_getLogs", "No upstream log scans");
      upstreamMethods[call.method] = (upstreamMethods[call.method] ?? 0) + 1;
    }
  }
  return originalFetch(input, init);
};
if (!process.env.ANVIL_BIN?.trim()) process.env.ANVIL_BIN = execFileSync("which", ["anvil"], { encoding: "utf8" }).trim();
let fork: Awaited<ReturnType<typeof startChainFork>> | undefined;
try {
  fork = await startChainFork(upstreamUrl, 4663, 4663);
  const client = createPublicClient({ chain: robinhood, transport: http(fork.rpc, { retryCount: 0, timeout: 40_000 }), pollingInterval: 100 });
  assert.equal(await client.getChainId(), 4663);
  assert.match(await fork.rpcCall("web3_clientVersion") as string, /anvil/i);
  const block = await client.getBlock({ blockNumber: fork.blockNumber });
  Object.assign(evidence, { forkBlockNumber: block.number, forkBlockHash: block.hash, forkBlockTimestamp: block.timestamp,
    anvil: execFileSync(process.env.ANVIL_BIN, ["--version"], { encoding: "utf8" }).trim().split("\n")[0] });
  evidence.stage = "router_source_binding";
  // Fetch the deployed address's verified source, not a generic router release. Keep a local copy for review.
  const response = await originalFetch(`https://sourcify.dev/server/v2/contract/4663/${ROBINHOOD_CONTRACTS.router}?fields=all`, { signal: AbortSignal.timeout(40_000) });
  assert(response.ok, `Router source fetch failed: ${response.status}`);
  const source = await response.json() as any;
  assert.equal(source.runtimeMatch, "match");
  const runtime = await client.getCode({ address: ROBINHOOD_CONTRACTS.router });
  assert.equal(runtime?.toLowerCase(), source.runtimeBytecode.onchainBytecode.toLowerCase(), "Verified source must match fork runtime exactly");
  const content = (path: string) => source.sources[path].content as string;
  const facts: [string, RegExp][] = [
    ["contracts/libraries/Commands.sol", /WRAP_ETH = 0x0b/], ["contracts/libraries/Commands.sol", /V4_SWAP = 0x10/],
    ["contracts/base/Dispatcher.sol", /command == Commands.WRAP_ETH[\s\S]*?recipient := calldataload\(inputs.offset\)[\s\S]*?amount := calldataload\(add\(inputs.offset, 0x20\)\)[\s\S]*?wrapETH\(map\(recipient\), amount\)/],
    ["lib/v4-periphery/src/libraries/ActionConstants.sol", /ADDRESS_THIS = address\(2\)/],
    ["lib/v4-periphery/src/libraries/Actions.sol", /SWAP_EXACT_IN_SINGLE = 0x06/],
    ["lib/v4-periphery/src/libraries/Actions.sol", /SETTLE = 0x0b/], ["lib/v4-periphery/src/libraries/Actions.sol", /TAKE_ALL = 0x0f/],
    ["lib/v4-periphery/src/V4Router.sol", /Currency currency, uint256 amount, bool payerIsUser.*decodeCurrencyUint256AndBool/],
    ["lib/v4-periphery/src/interfaces/IV4Router.sol", /uint128 amountOutMinimum;\s*uint256 minHopPriceX36;\s*bytes hookData;/],
  ];
  for (const [path, pattern] of facts) assert.match(content(path), pattern, path);
  await mkdir(sourcePath.slice(0, sourcePath.lastIndexOf("/")), { recursive: true });
  await writeFile(sourcePath, JSON.stringify(source, null, 2) + "\n");
  evidence.router = { address: ROBINHOOD_CONTRACTS.router, runtimeHash: keccak256(runtime!), runtimeMatchesVerifiedSource: true,
    compiler: source.compilation.compilerVersion, sourceSha256: sha256(JSON.stringify(source)),
    facts: { commands: "0x0b10", wrap: "address(2),uint256 amountIn", actions: "0x060b0f", settle: "WETH,uint256 amountIn,bool false", minHopPriceX36: "0" } };
  evidence.stage = "fork_quote";
  const coin = getAddress("0x7ea969d8c90C92c056949D561960Af2ACCd6E113"), weth = wrappedEther(4663);
  const state = await client.readContract({ address: ROBINHOOD_CONTRACTS.initializer, abi: feeSourceAbi, functionName: "getState", args: [coin] });
  assert(sameAddress(state[0], weth));
  const poolKey = state[5], sdk = new DopplerSDK<4663>({ chainId: 4663, publicClient: client });
  const amountIn = parseEther("0.0001");
  const quote = await sdk.quoter.quoteExactInputV4({ poolKey, zeroForOne: sameAddress(poolKey.currency0, weth), exactAmount: amountIn, hookData: "0x" });
  assert(quote.amountOut > 0n);
  const account = privateKeyToAddress(generatePrivateKey());
  assert.equal(await client.getCode({ address: account }), undefined);
  await fork.rpcCall("anvil_setBalance", [account, toHex(parseEther("1"))]);
  await fork.rpcCall("anvil_impersonateAccount", [account]);
  const tx = wrapAndSwapTransaction(poolKey, weth, amountIn, quote.amountOut, 100, block.timestamp + 300n);
  const balance = (asset: typeof coin, holder: typeof coin) => client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  const approvalState = async () => ({ erc20: await client.readContract({ address: weth, abi: erc20Abi, functionName: "allowance", args: [account, ROBINHOOD_CONTRACTS.permit2] }),
    permit2: await client.readContract({ address: ROBINHOOD_CONTRACTS.permit2, abi: permit2Abi, functionName: "allowance", args: [account, weth, tx.to] }) });
  const approvalsBefore = await approvalState();
  assert.deepEqual(approvalsBefore, { erc20: 0n, permit2: [0n, 0, 0] });
  evidence.stage = "negative_minimum";
  const impossible = wrapAndSwapTransaction(poolKey, weth, amountIn, quote.amountOut * 2n, 1, block.timestamp + 300n);
  const request = (built: typeof tx) => ({ from: account, to: built.to, data: built.data, value: toHex(built.value) });
  const failedCall = await originalFetch(fork.rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [request(impossible), "latest"] }) }).then(r => r.json()) as any;
  assert(failedCall.error, "An impossible minimum must revert");
  const decoded = decodeErrorResult({ abi: source.abi, data: failedCall.error.data });
  assert.equal(decoded.errorName, "V4TooLittleReceived");
  const failedHash = await fork.rpcCall("eth_sendTransaction", [{ ...request(impossible), gas: toHex(1_500_000n) }]) as Hex;
  const failedReceipt = await client.waitForTransactionReceipt({ hash: failedHash });
  assert.equal(failedReceipt.status, "reverted");
  evidence.negativeMinimum = { hash: failedHash, status: failedReceipt.status, minimum: impossible.minOut, achievableOutput: quote.amountOut, decodedRevert: decoded };
  evidence.stage = "native_buy";
  const ethBefore = await client.getBalance({ address: account }), coinBefore = await balance(coin, account);
  await client.call({ account, to: tx.to, data: tx.data, value: tx.value });
  const gas = await client.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value });
  const hash = await fork.rpcCall("eth_sendTransaction", [{ ...request(tx), gas: toHex(gas * 150n / 100n) }]) as Hex;
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `Native buy reverted: ${hash}`);
  const spent = ethBefore - await client.getBalance({ address: account }), received = await balance(coin, account) - coinBefore;
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  assert.equal(spent, tx.value + gasCost);
  assert(received >= tx.minOut);
  const routerEth = await client.getBalance({ address: tx.to }), routerWeth = await balance(weth, tx.to);
  assert.equal(routerEth, 0n); assert.equal(routerWeth, 0n); assert.equal(await balance(weth, account), 0n);
  assert.deepEqual(await approvalState(), approvalsBefore);
  assert(receipt.logs.every(log => log.topics[0] !== keccak256(toHex("Approval(address,address,uint256)"))), "No approval events");
  evidence.buy = { account, coin, poolKey, quote: { amountIn, amountOut: quote.amountOut }, transaction: tx, hash, status: receipt.status,
    received, spent, gasUsed: receipt.gasUsed, gasCost, routerEth, routerWeth, accountWeth: 0n, approvalsBefore, approvalsAfter: await approvalState(),
    approvalsMade: 0, transactionCount: await client.getTransactionCount({ address: account }) };
  evidence.status = "passed"; evidence.stage = "complete";
} catch (error) {
  evidence.status = "blocked"; evidence.error = safeForkError(error, [key]);
  process.exitCode = 1;
} finally {
  if (fork) {
    evidence.blockedUpstreamWrites = fork.blockedUpstreamWrites();
    const port = Number(new URL(fork.rpc).port);
    await fork.stop();
    const probe = createServer();
    await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(port, "127.0.0.1", resolve));
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    evidence.anvilPortFree = true;
  }
  globalThis.fetch = originalFetch;
  evidence.upstreamRpcMethods = upstreamMethods; evidence.upstreamRpcRequests = Object.values(upstreamMethods).reduce((a, b) => a + b, 0);
  evidence.completedAt = new Date().toISOString();
  const text = JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n";
  assert(!text.includes(key) || !key, "No API key in evidence"); assert(!/https?:\/\//i.test(text), "No RPC URLs in evidence");
  await mkdir(evidencePath.slice(0, evidencePath.lastIndexOf("/")), { recursive: true });
  await writeFile(evidencePath, text);
  console.log(JSON.stringify({ status: evidence.status, stage: evidence.stage, error: evidence.error, evidence: evidencePath }));
}
