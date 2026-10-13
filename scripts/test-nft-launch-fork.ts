import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  concat, createPublicClient, decodeErrorResult, decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, getAddress,
  http, keccak256, maxUint256, parseAbi, parseAbiItem, parseEther, toHex, zeroAddress,
  type Abi, type Address, type Hex, type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { robinhood } from "viem/chains";
import build from "../contracts/artifacts/nft-vault-build.json";
import { ROBINHOOD_CONTRACTS, ROBINHOOD_STOCKS, WAD, sameAddress } from "../src/lib/config";
import { ENGINE_FEE_POLICY, FEE_SHARES } from "../src/lib/fee-policy";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { LAUNCH_FEE_MIN_BLOCK, LAUNCH_FEE_STABLE } from "../src/lib/launch-fee";
import {
  DELEGATE_REGISTRY_V2, MUSES, NFT_LAUNCH_RIGHTS, NFT_VAULT_MANIFEST, TOKENBOUND_V3_IMPLEMENTATION, nftKey, treasuryFor, vaultFactory, vaultFor,
  type NftRef, type NftVaultManifest,
} from "../src/lib/nft-mode";
import { activateTreasuryTxs, deployVaultTx, sweepTx, withdrawTx } from "../src/lib/nft-treasury";
import { musegodSwapTransaction } from "../src/lib/musegod";
import { permit2Abi, swapTransaction } from "../src/lib/protocol";
import { runtimeFromEnv } from "../server/config";
import { ENGINE_MANIFEST } from "../server/launch-policy-registry";
import { MusegodReader } from "../server/musegod";
import { NftLaunchError, isContractAnswer } from "../server/nft-launch";
import { LaunchpadService } from "../server/service";
import { syntheticOpeningValuation } from "../tests/fixtures";
import {
  accountProxyAbi, accountV3Abi, factoryAbi, feeSourceAbi, isRateLimited, musesAbi, robinhoodUpstreamUrl, safeForkError, vaultAbi,
} from "./nft-vault-fork-helpers";
import { startChainFork } from "./robinhood-fork";

// Robinhood end-to-end NFT-mode launch on an isolated Anvil fork that keeps chain id 4663 (plan Task 12 Step 2).
// - Environment: only .env.fork (ALCHEMY_API_KEY), loaded by `node --env-file`. The real .env is never read; every other secret the
//   service needs is a throwaway value generated here.
// - Network: the fork's read-only upstream proxy and, only if no known USDG holder can pay, a bounded Transfer-log scan (at most ten
//   10-block windows); everything else is 127.0.0.1.
//   LI.FI is outside that set, so launches are priced from a synthetic opening valuation (NFT-mode rules do not depend on the price).
// - Writes: local fork transactions only, from fresh random addresses or mainnet accounts impersonated on the fork. No mainnet
//   transaction is signed or sent.
// - Manifest: the committed contracts/artifacts/nft-vault-deployment.json is never modified. A temporary copy names the factory
//   deployed on this fork and is passed explicitly to the service (Runtime.nftVaultManifest), vaultFor and the config.

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--chain" && ["robinhood", "4663"].includes(args[1])),
  "Usage: npm run test:nft-launch-fork -- --chain robinhood");
const key = process.env.ALCHEMY_API_KEY ?? "";
const upstreamUrl = robinhoodUpstreamUrl(key);
const redact = (error: unknown) => safeForkError(error, [key]);
if (!process.env.ANVIL_BIN?.trim() && !existsSync(".cache/bin/base-anvil-v1.1.1/anvil"))
  process.env.ANVIL_BIN = execFileSync("which", ["anvil"], { encoding: "utf8" }).trim();

const CHAIN_ID = 4663;
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const MANIFEST_PATH = "contracts/artifacts/nft-vault-deployment.json";
const SIGNING_NETWORK_GATE = "The signing network does not match the platform mode";
const FAILED_EVIDENCE = ".cache/nft-launch-fork-robinhood-failed.json";
const PASSED_EVIDENCE = "docs/evidence/nft-launch-fork-robinhood.json";
const ERC1967_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const MUSEGOD = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "MUSEGOD")!;
const WETH = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
const USDG = LAUNCH_FEE_STABLE[CHAIN_ID]!;
const ENGINE = getAddress(ENGINE_MANIFEST.contracts.engine.address ?? "");
const OPERATIONS_TREASURY = getAddress(ENGINE_MANIFEST.constants.treasury ?? "");
// The Uniswap v4 PoolManager holds the USDG of every v4 USDG pool; it was also the USDG donor of the earlier Robinhood fork evidence
// (docs/evidence/robinhood-fork-proof.json, launch-curve-fork.json, buyback-engine-fork.json).
const USDG_KNOWN_HOLDERS = [ROBINHOOD_CONTRACTS.poolManager];
// Synthetic USD prices for the opening valuation only (LI.FI is not reachable in this run).
const SYNTHETIC_PRICE_USD: Record<string, string> = { [MUSEGOD.address.toLowerCase()]: "0.0003", [WETH.address.toLowerCase()]: "3000" };
const museRef = (tokenId: bigint): NftRef => ({ chainId: CHAIN_ID, contract: MUSES.contract, tokenId: tokenId.toString() });
const delegateAbi = parseAbi([
  "function delegateERC721(address to, address contract_, uint256 tokenId, bytes32 rights, bool enable) payable returns (bytes32)",
  "function checkDelegateForERC721(address to, address from, address contract_, uint256 tokenId, bytes32 rights) view returns (bool)",
]);
const nftAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function supportsInterface(bytes4 id) view returns (bool)"]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// Fork-test-only ERC-721 for the paid launch: tokens 1 and 2 are minted to `holder` at construction. Compiled here with the
// project's Foundry toolchain (solc 0.8.24, offline), never deployed anywhere but this fork.
const FORK_TEST_NFT_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

contract ForkTestNft {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    mapping(uint256 => address) private owners;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    constructor(address holder) {
        for (uint256 id = 1; id <= 2; id++) {
            owners[id] = holder;
            emit Transfer(address(0), holder, id);
        }
        balanceOf[holder] = 2;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd;
    }

    function ownerOf(uint256 id) public view returns (address owner) {
        owner = owners[id];
        require(owner != address(0), "NOT_MINTED");
    }

    function approve(address spender, uint256 id) external {
        address owner = ownerOf(id);
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "NOT_AUTHORIZED");
        getApproved[id] = spender;
        emit Approval(owner, spender, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(from == ownerOf(id) && to != address(0), "WRONG_TRANSFER");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || msg.sender == getApproved[id], "NOT_AUTHORIZED");
        balanceOf[from]--;
        balanceOf[to]++;
        owners[id] = to;
        delete getApproved[id];
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        require(to.code.length == 0 || IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) == 0x150b7a02, "UNSAFE_RECIPIENT");
    }
}
`;

type StepName = "1_freeMuseLaunch" | "2_oneCoinPerNft" | "3_paidLaunch" | "4_feesFollowNft" | "5_nonHolderAndDelegate";
type Step = Record<string, unknown> & { status: "not_run" | "running" | "passed" | "failed" | "blocked" };
const stepNames: StepName[] = ["1_freeMuseLaunch", "2_oneCoinPerNft", "3_paidLaunch", "4_feesFollowNft", "5_nonHolderAndDelegate"];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const serialize = (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value;
/** Evidence text: never the API key, never a URL. Used on every write path, the fork-start failure included. */
function evidenceText(value: unknown) {
  const text = JSON.stringify(value, serialize, 2) + "\n";
  assert(!key || !text.includes(key), "Evidence must not contain the API key");
  assert(!/https?:\/\//i.test(text), "Evidence must not contain a URL");
  return text;
}
const committedManifestText = await readFile(MANIFEST_PATH, "utf8");
const evidence = {
  version: 1,
  scope: "Isolated Anvil fork of Robinhood Chain mainnet state, execution chain id 4663; local fork transactions only; no mainnet signing or broadcast; committed manifest unchanged",
  status: "running" as string, stage: "initializing", observedAt: new Date().toISOString(), completedAt: null as string | null,
  upstreamChainId: CHAIN_ID, executionChainId: CHAIN_ID,
  runnerSha256: sha256(await readFile(new URL(import.meta.url), "utf8")),
  anvil: execFileSync(process.env.ANVIL_BIN?.trim() || ".cache/bin/base-anvil-v1.1.1/anvil", ["--version"], { encoding: "utf8" }).split("\n")[0],
  forkBlockNumber: null as bigint | null, forkBlockHash: null as Hex | null, forkBlockTimestamp: null as bigint | null,
  launchFeeMinBlock: { minBlock: LAUNCH_FEE_MIN_BLOCK[CHAIN_ID]!, forkHeadAbove: null as boolean | null },
  multicall3: { address: MULTICALL3, codeLength: null as number | null, codeHash: null as Hex | null, hasCode: null as boolean | null },
  manifest: {
    committedSha256Before: sha256(committedManifestText), committedSha256After: null as string | null,
    committedRobinhoodStatus: NFT_VAULT_MANIFEST.chains["4663"].status, vaultInitCodeHash: NFT_VAULT_MANIFEST.vaultInitCodeHash,
    temporaryCopy: null as Record<string, unknown> | null,
  },
  service: null as Record<string, unknown> | null,
  openingValuation: { kind: "synthetic", quotePriceUsd: { MUSEGOD: SYNTHETIC_PRICE_USD[MUSEGOD.address.toLowerCase()], WETH: SYNTHETIC_PRICE_USD[WETH.address.toLowerCase()] } },
  actors: null as Record<string, Address> | null,
  mainnetTransactionsSubmitted: false, blockedUpstreamWrites: null as number | null, snapshotRestored: false,
  steps: Object.fromEntries(stepNames.map((name) => [name, { status: "not_run" }])) as Record<StepName, Step>,
  error: null as string | null,
};

let fork: Awaited<ReturnType<typeof startChainFork>>;
try { fork = await startChainFork(upstreamUrl, CHAIN_ID, CHAIN_ID); }
catch (error) {
  const message = redact(error);
  console.error(`BLOCKED: the Robinhood fork did not start: ${message}`);
  evidence.status = isRateLimited(message) ? "blocked_rate_limited" : "failed"; evidence.error = message;
  await mkdir(".cache", { recursive: true });
  await writeFile(FAILED_EVIDENCE, evidenceText(evidence));
  process.exit(1);
}
const client = createPublicClient({ chain: robinhood, pollingInterval: 100, transport: http(fork.rpc, { timeout: 120_000, retryCount: 0 }) });
const scratch = await mkdtemp(join(tmpdir(), "musegod-nft-launch-fork-"));

// ---------- local transaction helpers (as in scripts/test-nft-vault-fork.ts) ----------
async function rawRpc(method: string, params: unknown[]) {
  assert.equal(new URL(fork.rpc).hostname, "127.0.0.1");
  const response = await fetch(fork.rpc, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(120_000) });
  return await response.json() as { result?: unknown; error?: { code: number; message: string; data?: Hex } };
}
const errorAbi = [...accountV3Abi, ...accountProxyAbi, ...factoryAbi, ...vaultAbi, ...feeSourceAbi].filter((item) => item.type === "error") as Abi;
function decodeRevert(data: Hex | undefined, message: string) {
  if (!data || data === "0x") return message;
  try { const { errorName, args } = decodeErrorResult({ abi: errorAbi, data }); return `${errorName}(${(args ?? []).join(",")})`; }
  catch { return `${message} [${data.slice(0, 74)}]`; }
}
async function sendTx(from: Address, to: Address | null, data: Hex, value = 0n, gas?: bigint) {
  const request: Record<string, string> = { from, data, value: toHex(value) };
  if (to) request.to = to;
  if (gas === undefined) {
    const estimate = await rawRpc("eth_estimateGas", [request]);
    if (estimate.error) throw new Error(`Estimate failed from ${from} to ${to}: ${decodeRevert(estimate.error.data, estimate.error.message)}`);
    gas = BigInt(estimate.result as Hex) * 150n / 100n + 100_000n;
  }
  const hash = await fork.rpcCall("eth_sendTransaction", [{ ...request, gas: toHex(gas) }]) as Hex;
  return client.waitForTransactionReceipt({ hash });
}
async function send(from: Address, to: Address | null, data: Hex, value = 0n) {
  const receipt = await sendTx(from, to, data, value);
  assert.equal(receipt.status, "success", `Fork transaction ${receipt.transactionHash} reverted`);
  return receipt;
}
const tx = (receipt: TransactionReceipt) => ({ hash: receipt.transactionHash, blockNumber: receipt.blockNumber, status: receipt.status, gasUsed: receipt.gasUsed });
/** Calls first; when the call reverts, also mines the same transaction to record an on-chain reverted receipt. */
async function attempt(from: Address, to: Address, data: Hex) {
  const call = await rawRpc("eth_call", [{ from, to, data }, "latest"]);
  if (!call.error) return { accepted: true as const, receipt: tx(await send(from, to, data)) };
  const reason = decodeRevert(call.error.data, call.error.message);
  const receipt = await sendTx(from, to, data, 0n, 1_000_000n);
  assert.equal(receipt.status, "reverted", "The call reverted but the mined transaction did not");
  return { accepted: false as const, reason, receipt: tx(receipt) };
}
/** Two more blocks, so registration and fee checks see their confirmations. */
const confirm = () => fork.rpcCall("anvil_mine", ["0x2"]);
// Fresh random actors only: Anvil's default accounts are live on Robinhood mainnet and at least one carries an EIP-7702 delegation.
async function freshActor() {
  const address = privateKeyToAddress(generatePrivateKey());
  assert.equal(await code(address), "0x", "A fresh actor must have no code");
  await fork.rpcCall("anvil_setBalance", [address, toHex(parseEther("100"))]);
  await fork.rpcCall("anvil_impersonateAccount", [address]);
  return address;
}
async function impersonate(account: Address) {
  if (await client.getBalance({ address: account }) < parseEther("1")) await fork.rpcCall("anvil_setBalance", [account, toHex(parseEther("10"))]);
  await fork.rpcCall("anvil_impersonateAccount", [account]);
}
const code = async (address: Address) => (await client.getCode({ address })) ?? "0x";
const balanceOf = (token: Address, account: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
const shares = (source: Address, poolId: Hex, account: Address) =>
  client.readContract({ address: source, abi: feeSourceAbi, functionName: "getShares", args: [poolId, account] });
const implementationOf = async (account: Address) =>
  getAddress(`0x${((await client.getStorageAt({ address: account, slot: ERC1967_SLOT })) ?? "0x").slice(2).padStart(64, "0").slice(-40)}`);
/** Plain EOA, or an EOA with an EIP-7702 delegation: the accounts prepare accepts as a launcher. */
const launcherAccount = (runtime: Hex) => runtime === "0x" || /^0xef0100[\da-fA-F]{40}$/.test(runtime);
async function nftCode<T>(run: () => Promise<T>) {
  try { await run(); return "accepted"; }
  catch (error) { if (error instanceof NftLaunchError) return error.code; throw error; }
}

/** A real holder of `token` with at least `amount`, checked with balanceOf and a simulated transfer. First the known large holders;
 * then the parties of recent Transfer logs: one upstream getLogs per 10-block window, newest first, at most 10 windows and 25 new
 * parties per window. It stops at the first donor. A 429, or a refused window, stops the run. */
async function findDonor(token: Address, amount: bigint, known: Address[], exclude: Address[]) {
  const head = fork.blockNumber, candidatesTried: Record<string, unknown>[] = [], windowsScanned: Record<string, unknown>[] = [];
  const seen = new Set(exclude.map((a) => a.toLowerCase()));
  async function usable(candidate: Address, source: string) {
    seen.add(candidate.toLowerCase());
    const balance = await balanceOf(token, candidate);
    const simulation = balance < amount ? null : await rawRpc("eth_call", [{ from: candidate, to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [candidate, amount] }) }, "latest"]);
    const ok = !!simulation && !simulation.error;
    candidatesTried.push({ candidate, source, balance, transferSimulated: ok });
    return ok ? balance : null;
  }
  const found = (donor: Address, donorBalance: bigint) => ({ donor, donorBalance, candidatesTried, windowsScanned });
  for (const candidate of known) {
    if (seen.has(candidate.toLowerCase())) continue;
    const balance = await usable(candidate, "known holder");
    if (balance !== null) return found(candidate, balance);
  }
  for (let window = 0n; window < 10n; window++) {
    const toBlock = head - window * 10n, fromBlock = toBlock - 9n;
    let logs;
    try { logs = await fork.upstream.getLogs({ address: token, event: transferEvent, fromBlock, toBlock, strict: true }); }
    catch (error) {
      const message = redact(error);
      windowsScanned.push({ fromBlock, toBlock, refused: true });
      throw Object.assign(new Error(isRateLimited(message) ? `Upstream rate limit during the Transfer-log scan: ${message}`
        : `The Transfer-log scan was refused for blocks ${fromBlock}-${toBlock}: ${message}`), { blocked: true, candidatesTried, windowsScanned });
    }
    const parties = [...new Set(logs.flatMap((log) => [log.args.to, log.args.from]).filter((a): a is Address => !!a && !sameAddress(a, zeroAddress))
      .map((a) => getAddress(a)))].filter((a) => !seen.has(a.toLowerCase())).slice(0, 25);
    windowsScanned.push({ fromBlock, toBlock, logs: logs.length, newParties: parties.length });
    for (const candidate of parties) {
      const balance = await usable(candidate, `Transfer log, blocks ${fromBlock}-${toBlock}`);
      if (balance !== null) return found(candidate, balance);
    }
  }
  throw Object.assign(new Error(`No holder with at least ${amount} raw units of ${token} among the known holders and 10 recent 10-block windows`),
    { blocked: true, candidatesTried, windowsScanned });
}
async function fund(token: Address, to: Address, amount: bigint, known: Address[], exclude: Address[]) {
  const found = await findDonor(token, amount, known, [to, ...exclude]);
  await impersonate(found.donor);
  const before = await balanceOf(token, to);
  try {
    const receipt = await send(found.donor, token, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }));
    assert.equal(await balanceOf(token, to) - before, amount);
    return { kind: "existing holder inventory, impersonated on the fork only", ...found, amount, ...tx(receipt) };
  } finally { await fork.rpcCall("anvil_stopImpersonatingAccount", [found.donor]); }
}
/** The Muse whose holder can launch (no code, or an EIP-7702 delegation): Muse #`preferred` first, then the next ids (bounded). */
async function pickMuse(preferred: bigint) {
  const considered: Record<string, unknown>[] = [];
  for (let id = preferred; id < preferred + 20n; id++) {
    // Only the contract's own answer (a revert: no such token) skips an id; an RPC failure stops the run.
    const holder = await client.readContract({ address: MUSES.contract, abi: musesAbi, functionName: "ownerOf", args: [id] })
      .catch((error: unknown) => { if (isContractAnswer(error)) return null; throw error; });
    const runtime = holder ? await code(holder) : "0x";
    considered.push({ tokenId: id, holder, holderCodeLength: (runtime.length - 2) / 2 });
    if (holder && launcherAccount(runtime)) return { tokenId: id, holder, considered };
  }
  throw Object.assign(new Error(`No Muse from #${preferred} to #${preferred + 19n} has a holder that can launch`), { blocked: true });
}

async function compileForkTestNft(directory: string): Promise<Hex> {
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src", "ForkTestNft.sol"), FORK_TEST_NFT_SOURCE);
  await writeFile(join(directory, "foundry.toml"), '[profile.default]\nsrc = "src"\nout = "out"\nlibs = []\nsolc = "0.8.24"\nevm_version = "cancun"\noptimizer = true\n');
  execFileSync(process.env.FORGE_BIN?.trim() || "forge", ["build", "--root", directory, "--offline"], { stdio: ["ignore", "ignore", "inherit"] });
  return JSON.parse(await readFile(join(directory, "out", "ForkTestNft.sol", "ForkTestNft.json"), "utf8")).bytecode.object as Hex;
}

// The production service class with one test override: the opening valuation (LI.FI) is synthetic. Everything else, including the
// NFT checks, the fee-engine verification and the runtime manifest seam, is the production code path.
class ForkLaunchpadService extends LaunchpadService {
  override async openingValuation(quoteAddress: Address) {
    const price = SYNTHETIC_PRICE_USD[quoteAddress.toLowerCase()];
    assert(price, `No synthetic price for ${quoteAddress}`);
    return syntheticOpeningValuation(quoteAddress, price, { chainId: CHAIN_ID });
  }
}

let snapshot: Hex | undefined;
let current: StepName | undefined;
let service: ForkLaunchpadService | undefined;
async function step(name: StepName, run: (record: Step) => Promise<void>) {
  current = name; evidence.stage = name;
  const record = evidence.steps[name]; record.status = "running";
  console.log(`Step ${name}: running`);
  await run(record);
  record.status = "passed";
  console.log(`Step ${name}: passed`);
}

try {
  assert.equal(await client.getChainId(), CHAIN_ID);
  assert.match(await fork.rpcCall("web3_clientVersion") as string, /anvil/i);
  const pinned = await client.getBlock({ blockNumber: fork.blockNumber });
  Object.assign(evidence, { forkBlockNumber: fork.blockNumber, forkBlockHash: pinned.hash, forkBlockTimestamp: pinned.timestamp });
  evidence.launchFeeMinBlock.forkHeadAbove = fork.blockNumber > LAUNCH_FEE_MIN_BLOCK[CHAIN_ID]!;
  assert(evidence.launchFeeMinBlock.forkHeadAbove, "The fork head must be above LAUNCH_FEE_MIN_BLOCK[4663]");
  const multicall = await code(MULTICALL3);
  Object.assign(evidence.multicall3, { codeLength: (multicall.length - 2) / 2, codeHash: multicall === "0x" ? null : keccak256(multicall), hasCode: multicall !== "0x" });
  assert(evidence.multicall3.hasCode, "Multicall3 has no code on Robinhood Chain");

  const [deployer, trader, newHolder, outsider, paidCreator] = [await freshActor(), await freshActor(), await freshActor(), await freshActor(), await freshActor()];
  evidence.actors = { deployer, trader, newHolder, outsider, paidCreator };
  snapshot = await fork.rpcCall("evm_snapshot") as Hex;

  // ---------- the fork-local factory and the temporary manifest copy ----------
  const deployment = await send(deployer, null, build.factoryBytecode as Hex);
  const factory = getAddress(deployment.contractAddress!);
  const factoryRuntime = await code(factory);
  assert.equal(await client.readContract({ address: factory, abi: factoryAbi, functionName: "VAULT_INIT_CODE_HASH" }), NFT_VAULT_MANIFEST.vaultInitCodeHash);
  const temporary: NftVaultManifest = JSON.parse(committedManifestText);
  temporary.chains["4663"] = { status: "deployed_verified", factory, factoryRuntimeHash: keccak256(factoryRuntime),
    transactionHash: deployment.transactionHash, blockNumber: Number(deployment.blockNumber) };
  const manifestCopy = join(scratch, "nft-vault-deployment.fork.json");
  await writeFile(manifestCopy, JSON.stringify(temporary, null, 2) + "\n");
  const manifest = JSON.parse(await readFile(manifestCopy, "utf8")) as NftVaultManifest;
  assert.equal(vaultFactory(CHAIN_ID, manifest), factory);
  evidence.manifest.temporaryCopy = { location: "operating-system temporary directory, outside the repository", status: "deployed_verified",
    factory, factoryRuntimeHash: manifest.chains["4663"].factoryRuntimeHash, deploymentTransaction: deployment.transactionHash,
    deploymentBlock: deployment.blockNumber, vaultInitCodeHash: manifest.vaultInitCodeHash };

  // ---------- the service: production code, an isolated SQLite store, throwaway secrets ----------
  const runtime = runtimeFromEnv(undefined, {
    NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: String(CHAIN_ID), FORK_RPC_URL: fork.rpc, DATA_DIR: join(scratch, "store"),
    PLATFORM_TREASURY: OPERATIONS_TREASURY, FEE_ENGINE_ADDRESS: ENGINE, NFT_MODE_ENABLED: "true",
    PLAN_ATTESTATION_KEY: randomBytes(32).toString("hex"), LIFI_INTEGRATOR: "musegodfun",
  });
  // This fork keeps chain id 4663, so the Tokenbound account treats the Muses as same-chain NFTs (AccountV3 owner()).
  runtime.config.chainId = CHAIN_ID;
  runtime.config.nftMode = { ...runtime.config.nftMode!, vaultFactory: vaultFactory(CHAIN_ID, manifest) };
  runtime.nftVaultManifest = manifest;
  assert.equal(runtime.config.nftMode.enabled, true);
  service = new ForkLaunchpadService(runtime);
  const live = await service.config(true);
  evidence.service = { mode: live.mode, chainId: live.chainId, deploymentChainId: live.deploymentChainId, treasury: live.treasury,
    feePolicy: live.feePolicy, feeEngine: live.feeEngine, nftModeEnabled: live.nftMode?.enabled, vaultFactory: live.nftMode?.vaultFactory,
    store: "isolated SQLite in the temporary directory", secrets: "throwaway plan-attestation key generated for this run" };
  assert.equal(live.feePolicy, ENGINE_FEE_POLICY);
  assert(live.feeEngine && sameAddress(live.feeEngine, ENGINE), "The fee engine did not verify on the fork");
  assert(live.nftMode?.vaultFactory && sameAddress(live.nftMode.vaultFactory, factory), "The fork factory did not verify against the temporary manifest");
  const svc = service;

  async function launch(creator: Address, draft: Record<string, unknown>) {
    const plan = await svc.prepare(draft, creator, CURVE_POLICY);
    // validateLaunch repeats the plan-integrity check (assertNftFeeCalldata under the temporary manifest) and then reaches the signing
    // gate, which admits a fork only as chain id 31337. This fork keeps 4663 for the Tokenbound treasury, so it must stop exactly there.
    // Any other refusal (an integrity failure included) fails here with its own message shown.
    const refusal = await svc.validateLaunch(creator, plan.data).then(() => "accepted", (error: unknown) => error instanceof Error ? error.message : String(error));
    assert.equal(refusal, SIGNING_NETWORK_GATE);
    const sent = await sendTx(creator, plan.transaction!.to as Address, plan.data);
    assert.equal(sent.status, "success", `The launch ${sent.transactionHash} reverted`);
    await svc.trackLaunch(sent.transactionHash, plan.id);
    await confirm();
    const record = await svc.register(sent.transactionHash);
    return { plan, receipt: sent, record, validateLaunch: "integrity passed; refused only at the signing-network gate (fork chain id 4663)" };
  }
  const nftShares = async (poolId: Hex, holder: Address, vault: Address) => ({
    initializerVault: await shares(ROBINHOOD_CONTRACTS.initializer, poolId, vault), rehypeVault: await shares(ROBINHOOD_CONTRACTS.rehype, poolId, vault),
    initializerLauncher: await shares(ROBINHOOD_CONTRACTS.initializer, poolId, holder), rehypeLauncher: await shares(ROBINHOOD_CONTRACTS.rehype, poolId, holder),
    initializerEngine: await shares(ROBINHOOD_CONTRACTS.initializer, poolId, ENGINE), rehypeEngine: await shares(ROBINHOOD_CONTRACTS.rehype, poolId, ENGINE),
  });
  const expectedVaultShares = { initializer: WAD * BigInt(FEE_SHARES.creator) / 10_000n, rehype: WAD * BigInt(FEE_SHARES.creatorNet) / 10_000n };

  // ---------- 1. a free Muse launch, paired with MUSEGOD ----------
  let muse!: NftRef, museHolder!: Address, museCoin!: Address, musePoolId!: Hex, museVault!: Address, museTreasury!: Address;
  await step("1_freeMuseLaunch", async (s) => {
    const picked = await pickMuse(1n);
    muse = museRef(picked.tokenId); museHolder = getAddress(picked.holder!);
    museVault = vaultFor(muse, factory, manifest.vaultInitCodeHash); museTreasury = treasuryFor(muse);
    Object.assign(s, { museSelection: { preferredTokenId: 1, usedTokenId: picked.tokenId, considered: picked.considered }, nft: muse, holder: museHolder,
      vault: museVault, vaultCodeBefore: await code(museVault), treasury: museTreasury });
    assert.equal(await client.readContract({ address: factory, abi: factoryAbi, functionName: "vaultFor", args: [BigInt(CHAIN_ID), MUSES.contract, picked.tokenId] }), museVault);
    assert.equal(await code(museVault), "0x", "The Muse's vault must not exist before its launch");
    await impersonate(museHolder);
    const { plan, receipt, record, validateLaunch } = await launch(museHolder, { name: "Muse Fork Proof", symbol: "MUSEFP", description: "Isolated local Robinhood fork acceptance.",
      image: "", quoteAddress: MUSEGOD.address, nft: muse });
    museCoin = getAddress(record.address); musePoolId = record.poolId as Hex;
    const onchain = await nftShares(musePoolId, museHolder, museVault);
    Object.assign(s, { planId: plan.id, feePolicy: plan.feePolicy, validateLaunch, launch: tx(receipt), coin: museCoin, poolId: musePoolId,
      nftVerification: record.nftVerification, recordNft: record.nft, launchFee: record.launchFee ?? null, shares: onchain });
    assert.equal(plan.feePolicy, ENGINE_FEE_POLICY);
    assert.deepEqual(record.nftVerification, { status: "verified" });
    assert.deepEqual(record.nft, muse);
    assert.equal(record.launchFee, undefined, "A Muse launch is free");
    assert(sameAddress(record.quoteAddress, MUSEGOD.address));
    assert.equal(onchain.initializerVault, expectedVaultShares.initializer, "The initializer must pay the creator LP share to the vault");
    assert.equal(onchain.rehypeVault, expectedVaultShares.rehype, "Rehype must pay the creator hook share to the vault");
    assert.equal(onchain.initializerLauncher + onchain.rehypeLauncher, 0n, "The launcher holds no creator share");
    assert(onchain.initializerEngine > 0n && onchain.rehypeEngine > 0n, "The fee engine keeps its shares next to the vault");
    assert(sameAddress((await svc.store.verifiedNftCoin(nftKey(muse)))?.address ?? zeroAddress, museCoin), "The store must hold the Muse's verified coin");
  });

  // ---------- 2. one coin per NFT ----------
  await step("2_oneCoinPerNft", async (s) => {
    s.secondPrepare = await nftCode(() => svc.prepare({ name: "Muse Fork Again", symbol: "MUSEFA", description: "", image: "", quoteAddress: MUSEGOD.address, nft: muse },
      museHolder, CURVE_POLICY));
    assert.equal(s.secondPrepare, "NFT_ALREADY_LAUNCHED");
  });

  // ---------- 3. a paid launch: a minimal ERC-721 on the fork, exactly 10 USDG to the operations wallet ----------
  await step("3_paidLaunch", async (s) => {
    const bytecode = await compileForkTestNft(join(scratch, "nft"));
    const nftDeployment = await send(deployer, null, concat([bytecode, encodeAbiParameters([{ type: "address" }], [paidCreator])]));
    const collection = getAddress(nftDeployment.contractAddress!);
    const paid: NftRef = { chainId: CHAIN_ID, contract: collection, tokenId: "1" };
    assert.equal(await client.readContract({ address: collection, abi: nftAbi, functionName: "supportsInterface", args: ["0x80ac58cd"] }), true);
    assert(sameAddress(await client.readContract({ address: collection, abi: nftAbi, functionName: "ownerOf", args: [1n] }), paidCreator));
    const funding = await fund(USDG.address, paidCreator, USDG.amount, USDG_KNOWN_HOLDERS, [OPERATIONS_TREASURY]);
    const treasuryBefore = await balanceOf(USDG.address, OPERATIONS_TREASURY);
    const payment = await send(paidCreator, USDG.address, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [OPERATIONS_TREASURY, USDG.amount] }));
    await confirm();
    const treasuryDelta = await balanceOf(USDG.address, OPERATIONS_TREASURY) - treasuryBefore;
    assert.equal(treasuryDelta, USDG.amount, "Exactly 10 USDG must reach config.treasury");
    assert(payment.blockNumber >= LAUNCH_FEE_MIN_BLOCK[CHAIN_ID]!);
    const fee = { asset: "stable" as const, txHash: payment.transactionHash };
    const { plan, receipt, record, validateLaunch } = await launch(paidCreator, { name: "Paid NFT Fork Proof", symbol: "PAIDFP", description: "Isolated local Robinhood fork acceptance.",
      image: "", quoteAddress: WETH.address, nft: paid, launchFee: fee });
    const vault = vaultFor(paid, factory, manifest.vaultInitCodeHash);
    const onchain = await nftShares(record.poolId as Hex, paidCreator, vault);
    Object.assign(s, { collection: { address: collection, deployment: tx(nftDeployment), bytecodeKeccak: keccak256(bytecode), holder: paidCreator, tokenIds: [1, 2] },
      usdgFunding: funding, payment: { ...tx(payment), token: USDG.address, from: paidCreator, to: OPERATIONS_TREASURY, amount: USDG.amount, treasuryDelta },
      planId: plan.id, validateLaunch, launch: tx(receipt), coin: record.address, poolId: record.poolId, quote: record.quoteAddress, vault,
      nftVerification: record.nftVerification, launchFee: record.launchFee ?? null, shares: onchain });
    assert.deepEqual(record.nftVerification, { status: "verified" });
    assert.deepEqual(record.nft, paid);
    assert.deepEqual(record.launchFee, { asset: "stable", txHash: payment.transactionHash.toLowerCase() });
    assert.equal(onchain.initializerVault, expectedVaultShares.initializer);
    assert.equal(onchain.rehypeVault, expectedVaultShares.rehype);
    assert(sameAddress((await svc.store.tokenUsingLaunchFee(payment.transactionHash, paidCreator))!.address, record.address));
    s.reuseForAnotherNft = await nftCode(() => svc.prepare({ name: "Paid NFT Again", symbol: "PAIDFA", description: "", image: "", quoteAddress: WETH.address,
      nft: { ...paid, tokenId: "2" }, launchFee: fee }, paidCreator, CURVE_POLICY));
    assert.equal(s.reuseForAnotherNft, "NFT_FEE_USED");
  });

  // ---------- 4. fees follow the NFT ----------
  await step("4_feesFollowNft", async (s) => {
    // The trader gets MUSEGOD the way the site's "Get MUSEGOD with ETH" panel does: an ETH buy on the MUSEGOD SushiSwap v3 pool,
    // quoted and encoded by the production MUSEGOD reader. Its network gate admits a fork only as chain id 31337, so it is handed the
    // Robinhood view of this config; its client is still the fork.
    const museMarketConfig = { ...runtime.config, mode: "robinhood" as const };
    const museMarket = new MusegodReader(svc.client, museMarketConfig, () => svc.assertNetwork());
    const ethQuote = await museMarket.quote("buy", "0.01", 100);
    const ethBuy = musegodSwapTransaction(ethQuote, trader, museMarketConfig);
    const musegodBefore = await balanceOf(MUSEGOD.address, trader);
    const ethBuyReceipt = await send(trader, ethBuy.to, ethBuy.data, ethBuy.value);
    const buyAmount = await balanceOf(MUSEGOD.address, trader) - musegodBefore;
    assert(buyAmount >= BigInt(ethQuote.minAmountOut), "The MUSEGOD buy returned less than its minimum");
    const funding = { kind: "ETH buy of MUSEGOD on its SushiSwap v3 pool, local fork transaction", ...tx(ethBuyReceipt), ethIn: ethBuy.value,
      musegodOut: buyAmount, pool: ethQuote.poolAddress };
    async function trade(currencyIn: Address, amountIn: bigint) {
      const side = sameAddress(currencyIn, MUSEGOD.address) ? "buy" : "sell";
      const quote = await svc.quote(museCoin, side, formatUnits(amountIn, 18), 100);
      if (await client.readContract({ address: currencyIn, abi: erc20Abi, functionName: "allowance", args: [trader, ROBINHOOD_CONTRACTS.permit2] }) < amountIn)
        await send(trader, currencyIn, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROBINHOOD_CONTRACTS.permit2, maxUint256] }));
      const deadline = (await client.getBlock()).timestamp + 600n;
      await send(trader, ROBINHOOD_CONTRACTS.permit2, encodeFunctionData({ abi: permit2Abi, functionName: "approve",
        args: [currencyIn, ROBINHOOD_CONTRACTS.router, amountIn, Number(deadline)] }));
      const swap = swapTransaction(quote.poolKey, currencyIn, amountIn, BigInt(quote.amountOut), 100, deadline, ROBINHOOD_CONTRACTS);
      const before = await balanceOf(swap.currencyOut, trader);
      const receipt = await send(trader, swap.to, swap.data, swap.value);
      const amountOut = await balanceOf(swap.currencyOut, trader) - before;
      assert(amountOut >= swap.minOut);
      return { side, ...tx(receipt), amountIn, quotedOut: BigInt(quote.amountOut), amountOut };
    }
    const buy = await trade(MUSEGOD.address, buyAmount);
    const sell = await trade(museCoin, buy.amountOut);
    const view = await svc.nftTreasury(nftKey(muse));
    assert(sameAddress(view.vault, museVault) && sameAddress(view.treasury, museTreasury));
    Object.assign(s, { musegodFunding: funding, trades: { buy, sell }, treasuryViewBeforeSweep: { vault: view.vault, vaultDeployed: view.vaultDeployed,
      treasury: view.treasury, treasuryDeployed: view.treasuryDeployed, pendingFees: view.pendingFees } });

    const tokens = [museCoin, MUSEGOD.address];
    const deploy = deployVaultTx(factory, muse);
    s.vaultDeployment = tx(await send(deployer, deploy.to, deploy.data));
    assert.notEqual(await code(museVault), "0x", "The vault was not deployed at its predicted address");
    const treasuryCodeBefore = await code(museTreasury);
    const held = async (account: Address) => Object.fromEntries(await Promise.all(tokens.map(async (token) => [token, await balanceOf(token, account)] as const)));
    const before = { treasury: await held(museTreasury), vault: await held(museVault) };
    const sweep = sweepTx(museVault, [musePoolId], tokens);
    const swept = await send(deployer, sweep.to, sweep.data);
    const events = swept.logs.filter((log) => sameAddress(log.address, museVault)).map((log) => decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics }));
    const after = { treasury: await held(museTreasury), vault: await held(museVault) };
    const sweptDelta = Object.fromEntries(tokens.map((token) => [token, after.treasury[token] - before.treasury[token]]));
    const outflows = swept.logs.flatMap((log) => {
      try {
        const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        return event.eventName === "Transfer" && sameAddress(event.args.from, museVault) ? [{ token: getAddress(log.address), to: event.args.to, amount: event.args.value }] : [];
      } catch { return []; }
    });
    s.sweep = { ...tx(swept), caller: deployer, tokens, before, after, treasuryDelta: sweptDelta, treasuryHadCode: treasuryCodeBefore !== "0x",
      vaultEvents: events.map((event) => ({ name: event.eventName, args: event.args })), vaultOutflows: outflows };
    assert.deepEqual(events.filter((event) => event.eventName === "FeeClaimFailed" || event.eventName === "SweepFailed"), [], "A claim or forward failed");
    assert(outflows.every((item) => sameAddress(item.to, museTreasury)), "The vault sent funds somewhere other than the NFT's treasury");
    for (const token of tokens) assert.equal(after.vault[token], 0n, "The vault must end empty");
    assert(Object.values(sweptDelta).some((amount) => amount > 0n), "The sweep moved no fees into the treasury");
    // The treasury view's pending-fee preview (LP plus hook, per pool currency) is exactly what the sweep delivered.
    type FeePreview = { token: Address; lp: { fees0: bigint; fees1: bigint }; trade: { fees0: bigint; fees1: bigint }; poolKey: { currency0: Address; currency1: Address } };
    const preview = (view.pendingFees as Partial<FeePreview>[]).find((entry) => entry.token && sameAddress(entry.token, museCoin)) as FeePreview | undefined;
    assert(preview?.lp && preview.trade && preview.poolKey, "The treasury view has no fee preview for the Muse coin");
    assert.deepEqual({ [getAddress(preview.poolKey.currency0)]: preview.lp.fees0 + preview.trade.fees0, [getAddress(preview.poolKey.currency1)]: preview.lp.fees1 + preview.trade.fees1 },
      Object.fromEntries(tokens.map((token) => [getAddress(token), sweptDelta[token]])), "The sweep must deliver exactly the previewed pending fees");
    if (treasuryCodeBefore === "0x")
      assert.deepEqual(events.filter((event) => event.eventName === "TreasuryActivation").map((event) => event.args),
        [{ treasury: museTreasury, created: true, initialized: true }], "The first sweep must create and initialize the treasury");

    // Activate the treasury the way the UI does. The sweep already did, so creation is a no-op and initialize is refused.
    const [create, initialize] = activateTreasuryTxs(muse);
    const codeHash = keccak256(await code(museTreasury));
    s.activateTreasury = { createAccount: tx(await send(museHolder, create.to, create.data)),
      initialize: await rawRpc("eth_call", [{ from: museHolder, to: initialize.to, data: initialize.data }, "latest"])
        .then((call) => call.error ? { accepted: false, reason: decodeRevert(call.error.data, call.error.message) } : { accepted: true }) };
    assert.equal(keccak256(await code(museTreasury)), codeHash, "createAccount must not replace an existing account");
    assert.equal(await implementationOf(museTreasury), TOKENBOUND_V3_IMPLEMENTATION, "The treasury must run the Tokenbound V3 implementation");
    assert(sameAddress(await client.readContract({ address: museTreasury, abi: accountV3Abi, functionName: "owner" }), museHolder));

    // The holder sells the NFT: control of the treasury moves with it.
    s.museTransfer = tx(await send(museHolder, MUSES.contract, encodeFunctionData({ abi: musesAbi, functionName: "safeTransferFrom",
      args: [museHolder, newHolder, BigInt(muse.tokenId)] })));
    assert(sameAddress(await client.readContract({ address: MUSES.contract, abi: musesAbi, functionName: "ownerOf", args: [BigInt(muse.tokenId)] }), newHolder));
    assert(sameAddress(await client.readContract({ address: museTreasury, abi: accountV3Abi, functionName: "owner" }), newHolder));
    const withdrawals: Record<string, unknown>[] = [];
    for (const token of tokens) {
      const amount = sweptDelta[token];
      if (amount <= 0n) continue;
      const treasuryBefore = await balanceOf(token, museTreasury);
      const old = withdrawTx(muse, token, museHolder, amount);
      const oldHolder = await attempt(museHolder, old.to, old.data);
      assert.equal(oldHolder.accepted, false, "The old holder still controls the treasury");
      assert.equal(oldHolder.reason, "NotAuthorized()");
      assert.equal(await balanceOf(token, museTreasury), treasuryBefore);
      const next = withdrawTx(muse, token, newHolder, amount);
      const received = await balanceOf(token, newHolder);
      const newHolderWithdraw = tx(await send(newHolder, next.to, next.data));
      const delta = await balanceOf(token, newHolder) - received;
      assert.equal(delta, amount, "The new holder must receive exactly the swept balance");
      withdrawals.push({ token, sweptAmount: amount, oldHolder, newHolder: { ...newHolderWithdraw, received: delta } });
    }
    s.withdrawals = withdrawals;
    assert(withdrawals.length > 0);
  });

  // ---------- 5. a non-holder is refused; a delegate.xyz delegate of the holder is accepted ----------
  await step("5_nonHolderAndDelegate", async (s) => {
    const picked = await pickMuse(BigInt(muse.tokenId) + 1n);
    const other = museRef(picked.tokenId), holder = getAddress(picked.holder!);
    const draft = { name: "Muse Delegate Proof", symbol: "MUSEDP", description: "", image: "", quoteAddress: MUSEGOD.address, nft: other };
    assert.equal(await svc.store.verifiedNftCoin(nftKey(other)), null);
    s.nft = other; s.holder = holder; s.account = outsider;
    s.nonHolderPrepare = await nftCode(() => svc.prepare(draft, outsider, CURVE_POLICY));
    assert.equal(s.nonHolderPrepare, "NFT_NOT_CONTROLLED");
    await impersonate(holder);
    s.delegation = { registry: DELEGATE_REGISTRY_V2, rights: NFT_LAUNCH_RIGHTS, ...tx(await send(holder, DELEGATE_REGISTRY_V2,
      encodeFunctionData({ abi: delegateAbi, functionName: "delegateERC721", args: [outsider, MUSES.contract, picked.tokenId, NFT_LAUNCH_RIGHTS, true] }))) };
    assert.equal(await client.readContract({ address: DELEGATE_REGISTRY_V2, abi: delegateAbi, functionName: "checkDelegateForERC721",
      args: [outsider, holder, MUSES.contract, picked.tokenId, NFT_LAUNCH_RIGHTS] }), true);
    const plan = await svc.prepare(draft, outsider, CURVE_POLICY);
    Object.assign(s, { delegatePrepare: "accepted", planId: plan.id, planCreator: plan.creator, planNft: plan.draft.nft,
      vault: vaultFor(other, factory, manifest.vaultInitCodeHash) });
    assert(sameAddress(plan.creator, outsider));
    assert.deepEqual(plan.draft.nft, other);
  });

  evidence.status = "passed";
  evidence.stage = "completed";
} catch (error) {
  const message = redact(error);
  evidence.error = message;
  const blocked = !!(error as { blocked?: boolean })?.blocked;
  const record = current ? evidence.steps[current] : undefined;
  if (record) { record.status = blocked ? "blocked" : "failed"; record.error = message; }
  // A donor search that found nobody still records what it tried.
  const scan = error as { candidatesTried?: unknown; windowsScanned?: unknown };
  if (record && scan?.candidatesTried) Object.assign(record, { donorSearch: { candidatesTried: scan.candidatesTried, windowsScanned: scan.windowsScanned } });
  evidence.status = isRateLimited(message) ? "blocked_rate_limited" : blocked ? "blocked" : "failed";
  console.error(`${evidence.status.toUpperCase()} at ${evidence.stage}: ${message}`);
} finally {
  try { await service?.store.close(); } catch { /* already closed */ }
  try { if (snapshot) evidence.snapshotRestored = await fork.rpcCall("evm_revert", [snapshot]) as boolean; }
  catch (error) { console.error(`Snapshot restore failed: ${redact(error)}`); }
  finally {
    evidence.blockedUpstreamWrites = fork.blockedUpstreamWrites();
    await fork.stop();
    await rm(scratch, { recursive: true, force: true });
  }
  evidence.manifest.committedSha256After = sha256(await readFile(MANIFEST_PATH, "utf8"));
  if (evidence.status === "passed" && evidence.manifest.committedSha256After !== evidence.manifest.committedSha256Before) {
    evidence.status = "failed"; evidence.error = "The committed manifest changed during the run";
  }
  if (evidence.blockedUpstreamWrites !== 0 && evidence.status === "passed") { evidence.status = "failed"; evidence.error = "An upstream write was attempted"; }
  evidence.completedAt = new Date().toISOString();
  // A failed run never replaces the last passing evidence and stays out of git (.cache is ignored).
  const path = evidence.status === "passed" ? PASSED_EVIDENCE : FAILED_EVIDENCE;
  const text = evidenceText(evidence);
  await mkdir(path.startsWith(".cache") ? ".cache" : "docs/evidence", { recursive: true });
  await writeFile(path, text);
  console.log(JSON.stringify({ status: evidence.status, forkBlockNumber: evidence.forkBlockNumber, evidence: path,
    steps: Object.fromEntries(stepNames.map((name) => [name, evidence.steps[name].status])) }, serialize));
}
if (evidence.status !== "passed") process.exitCode = 1;
