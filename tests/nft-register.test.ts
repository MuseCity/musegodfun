import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DopplerSDK, airlockAbi, computePoolId, rehypeDopplerHookInitializerAbi } from "@whetstone-research/doppler-sdk/evm";
import { ContractFunctionExecutionError, HttpRequestError, isHex, TimeoutError, TransactionNotFoundError, TransactionReceiptNotFoundError, createPublicClient, decodeFunctionData,
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, http, keccak256, multicall3Abi, zeroAddress,
  type Address, type Hex } from "viem";
import { base as baseChain } from "viem/chains";
import { ROBINHOOD_CONTRACTS as contracts, ROBINHOOD_STOCKS, SUPPLY, type TokenRecord } from "../src/lib/config";
import { MUSES, NFT_VAULT_MANIFEST, nftKey } from "../src/lib/nft-mode";
import { LAUNCH_FEE_MIN_BLOCK, LAUNCH_FEE_STABLE } from "../src/lib/launch-fee";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { buildLaunch } from "../src/lib/protocol";
import { LAUNCH_SIGNING_TTL, serializePrepared, type LaunchPlan } from "../src/lib/launch-plan";
import { NftLaunchError, isBoundNftCoin, isContractAnswer, launchFeeQuoteMac, nftRegistrationStatus, readNftControl } from "../server/nft-launch";
import { listedNftCoin } from "../src/lib/nft-treasury";
import { ENGINE_MANIFEST } from "../server/launch-policy-registry";
import { LaunchClaimUnavailable, LaunchpadService } from "../server/service";
import { createApp } from "../server/app";
import { runtimeFromEnv } from "../server/config";
import { Store, TokenUniqueConflict } from "../server/store";
import { SupabaseStore } from "../server/supabase-store";
import { nftReverifyCommand, type NftReverifyDeps } from "../scripts/nft-reverify";
import { syntheticOpeningValuation, syntheticToken } from "./fixtures";

const holder = "0xAAAA000000000000000000000000000000000001" as Address, other = "0xBBBB000000000000000000000000000000000002" as Address;
const musegod = ROBINHOOD_STOCKS.find((a) => a.symbol === "MUSEGOD")!, weth = ROBINHOOD_STOCKS.find((a) => a.symbol === "WETH")!;
const muse = { chainId: 4663 as const, contract: MUSES.contract, tokenId: "1" };
const ownedBy = (owner: Address | "fail") => ({ readContract: async ({ functionName }: { functionName: string }) => {
  if (owner === "fail") throw new Error("rpc down");
  return functionName === "supportsInterface" ? true : functionName === "ownerOf" ? owner : false;
} }) as never;
const base = { nft: muse, creator: holder, quoteAddress: musegod.address, receiptTimestamp: 1000n, nowSeconds: 1010n, existing: null };

test("verified when the creator still controls the NFT", async () => {
  assert.deepEqual(await nftRegistrationStatus({ ...base, client: ownedBy(holder) }), { status: "verified" });
});
test("rejected when control moved, when another verified coin exists, or when a Muse coin is not MUSEGOD-paired", async () => {
  assert.equal((await nftRegistrationStatus({ ...base, client: ownedBy(other) }) as { reason: string }).reason, "not_controller");
  assert.equal((await nftRegistrationStatus({ ...base, client: ownedBy(holder), existing: { address: other } as never }) as { reason: string }).reason, "already_launched");
  assert.equal((await nftRegistrationStatus({ ...base, client: ownedBy(holder), quoteAddress: weth.address }) as { reason: string }).reason, "pair");
});
test("an RPC failure asks for a retry within 10 minutes, then records unverified", async () => {
  assert.equal(await nftRegistrationStatus({ ...base, client: ownedBy("fail") }), "retry");
  assert.deepEqual(await nftRegistrationStatus({ ...base, client: ownedBy("fail"), nowSeconds: 1000n + 601n }), { status: "unverified", reason: "rpc" });
});
test("an unpaid non-Muse coin is rejected for its badge but still registers", async () => {
  const nft = { ...muse, contract: "0x1111111111111111111111111111111111111111" as Address };
  assert.equal((await nftRegistrationStatus({ ...base, nft, quoteAddress: weth.address, client: ownedBy(holder), fee: "invalid" }) as { reason: string }).reason, "fee");
  assert.deepEqual(await nftRegistrationStatus({ ...base, nft, quoteAddress: weth.address, client: ownedBy(holder), fee: "paid" }), { status: "verified" });
});
test("a fee that could not be confirmed (past 10 minutes) leaves a controlled coin unverified, never rejected: fee", async () => {
  const nft = { ...muse, contract: "0x1111111111111111111111111111111111111111" as Address };
  const late = { ...base, nft, quoteAddress: weth.address, fee: "unconfirmed" as const, nowSeconds: 1000n + 601n };
  assert.deepEqual(await nftRegistrationStatus({ ...late, client: ownedBy(holder) }), { status: "unverified", reason: "fee_unconfirmed" });
  // The other rules are definite, so they still decide.
  assert.equal((await nftRegistrationStatus({ ...late, client: ownedBy(other) }) as { reason: string }).reason, "not_controller");
  assert.equal((await nftRegistrationStatus({ ...late, client: ownedBy(holder), existing: { address: other } as never }) as { reason: string }).reason, "already_launched");
  assert.deepEqual(await nftRegistrationStatus({ ...late, client: ownedBy("fail") }), { status: "unverified", reason: "rpc" });
});

// ---- readNftControl: the node's failures propagate, the contract's answers do not -------------------------------------------

type RpcAnswer = { result: Hex } | { error: { code: number; message: string; data?: Hex } } | "http500" | "hang" | "fail";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
/** A real viem client over a scripted JSON-RPC endpoint, so the errors are the ones viem actually builds (plain and multicall batching). */
function scriptedClient(answer: (functionData: Hex) => RpcAnswer, multicall: boolean) {
  const fetchFn = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)), items = Array.isArray(body) ? body : [body];
    const answers = items.map((item: { params: [{ to: string; data: Hex }] }) => {
      const call = item.params[0];
      if (multicall && call.to.toLowerCase() === MULTICALL3) {
        const calls = decodeFunctionData({ abi: multicall3Abi, data: call.data }).args![0] as readonly { callData: Hex }[];
        const each = calls.map((entry) => answer(entry.callData));
        const shared = each.find((entry) => typeof entry === "string" || "error" in entry && (entry.error.code !== 3 || entry.error.data !== undefined && !isHex(entry.error.data)));
        if (shared) return shared;
        // A per-call revert is aggregate3's success=false, exactly as on chain.
        return { result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: each.map((entry) =>
          "result" in (entry as object) ? { success: true, returnData: (entry as { result: Hex }).result }
            : { success: false, returnData: (entry as { error: { data?: Hex } }).error.data ?? "0x" }) }) } as RpcAnswer;
      }
      return answer(call.data);
    });
    if (answers.includes("http500")) return new Response("upstream unavailable", { status: 500 });
    if (answers.includes("hang")) return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
    const out = items.map((item: { id: number }, index: number) => ({ jsonrpc: "2.0", id: item.id, ...(answers[index] as object) }));
    return Response.json(Array.isArray(body) ? out : out[0]);
  };
  return createPublicClient({ chain: baseChain, transport: http("https://rpc.fixture.test", { fetchFn, retryCount: 0, timeout: 100 }), batch: { multicall } });
}
const selector = (name: "supportsInterface" | "ownerOf" | "checkDelegateForERC721") =>
  ({ supportsInterface: "0x01ffc9a7", ownerOf: "0x6352211e", checkDelegateForERC721: "0xb9ae736f" })[name];
const word = (value: bigint | Address | boolean) => encodeAbiParameters([{ type: typeof value === "boolean" ? "bool" : typeof value === "bigint" ? "uint256" : "address" }], [value as never]);
/** supportsInterface and ownerOf answer as given; the delegate check answers false. */
function nftNode(supports: RpcAnswer, ownerOf: RpcAnswer, multicall: boolean) {
  return scriptedClient((data) => data.startsWith(selector("supportsInterface")) ? supports : data.startsWith(selector("ownerOf")) ? ownerOf : { result: word(false) }, multicall);
}
const revertString = (reason: string) => `0x08c379a0${encodeAbiParameters([{ type: "string" }], [reason]).slice(2)}` as Hex;
const yes = { result: word(true) } as const;
// The brief's holder literal is mixed-case with an invalid checksum, which viem's strict ABI encoder rejects.
const owner = getAddress(holder);

test("readNftControl: HTTP failures, timeouts, rate limits and node errors propagate; they never read as not-held or not-ERC-721", async () => {
  const failures: [string, RpcAnswer, (error: unknown) => boolean][] = [
    ["HTTP 500", "http500", (e) => e instanceof Error && (e as { walk?: (fn: (x: unknown) => boolean) => unknown }).walk?.((x) => x instanceof HttpRequestError) != null],
    ["timeout", "hang", (e) => (e as { walk: (fn: (x: unknown) => boolean) => unknown }).walk((x) => x instanceof TimeoutError) != null],
    ["rate limit", { error: { code: 429, message: "Too Many Requests" } }, () => true],
    ["internal error without revert data", { error: { code: -32603, message: "internal error" } }, () => true],
    ["missing state", { error: { code: -32000, message: "header not found" } }, () => true],
  ];
  for (const multicall of [false, true]) for (const [name, answer, kind] of failures) {
    for (const client of [nftNode(answer, { result: word(owner) }, multicall), nftNode(yes, answer, multicall)]) {
      const error = await readNftControl(client, muse, owner).then(() => null, (e: unknown) => e);
      assert(error, `${name} (multicall ${multicall}) must throw`);
      assert.equal(isContractAnswer(error), false, name);
      assert(kind(error), `${name} keeps its viem error class`);
    }
  }
});

test("readNftControl: reverts, empty and undecodable answers are the contract's and map to false/null", async () => {
  const answers: [string, RpcAnswer][] = [
    ["Error(string) revert", { error: { code: 3, message: "execution reverted: ERC721: invalid token ID", data: revertString("ERC721: invalid token ID") } }],
    ["custom-error revert", { error: { code: 3, message: "execution reverted", data: `0x7e273289${"00".repeat(31)}01` } }],
    ["revert without data", { error: { code: -32000, message: "execution reverted" } }],
    ["no code at the address", { result: "0x" }],
    ["undecodable bool", { result: `0x${"00".repeat(31)}05` }],
    ["short return data", { result: "0x1234" }],
  ];
  for (const multicall of [false, true]) for (const [name, answer] of answers) {
    assert.deepEqual(await readNftControl(nftNode(answer, { result: word(owner) }, multicall), muse, owner), { erc721: false, owner: null, controls: false },
      `supportsInterface: ${name} (multicall ${multicall})`);
    if (name !== "undecodable bool")
      assert.deepEqual(await readNftControl(nftNode(yes, answer, multicall), muse, owner), { erc721: true, owner: null, controls: false },
        `ownerOf: ${name} (multicall ${multicall})`);
  }
  assert.deepEqual(await readNftControl(nftNode(yes, { result: word(owner) }, true), muse, owner), { erc721: true, owner: owner, controls: true });
});

test("readNftControl: revert data must be hex of at least a selector; a provider's non-hex data string is the node's failure", async () => {
  for (const multicall of [false, true]) {
    for (const [name, answer] of [
      ["-32603 with a text data field", { error: { code: -32603, message: "internal error", data: "upstream timeout" as Hex } }],
      ["code 3 with a text data field", { error: { code: 3, message: "execution reverted", data: "gateway busy" as Hex } }],
      ["code 3 with fewer than four bytes", { error: { code: 3, message: "execution reverted", data: "0x123456" as Hex } }],
    ] as [string, RpcAnswer][]) {
      const error = await readNftControl(nftNode(yes, answer, multicall), muse, owner).then(() => null, (e: unknown) => e);
      assert(error && !isContractAnswer(error), `${name} (multicall ${multicall}) propagates`);
    }
    assert.deepEqual(await readNftControl(nftNode(yes, { error: { code: 3, message: "execution reverted", data: "0x7e273289" } }, multicall), muse, owner),
      { erc721: true, owner: null, controls: false }, "a bare four-byte selector is a revert");
  }
});

test("prepare surfaces an RPC outage as an error, not NFT_NOT_CONTROLLED or NFT_NOT_ERC721", async () => {
  const run = async (client: unknown) => {
    const service = Object.assign(Object.create(LaunchpadService.prototype), {
      runtime: { config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: "0x2222222222222222222222222222222222222222", writesEnabled: true,
        blockReason: null, nftMode: { enabled: true, vaultFactory: "0x00000000000000000000000000000000000fac70", launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } } },
      assertNetwork: async () => {}, assertCreatorAccount: async () => {}, client,
      store: { verifiedNftCoin: async () => null, nftGuardsReady: async () => true },
    }) as LaunchpadService;
    const draft = { name: "Bard", symbol: "BARD", description: "", image: "", quoteAddress: musegod.address, tradingFeeBps: 100, nft: muse };
    try { await service.prepare(draft, owner, CURVE_POLICY); return "ok"; }
    catch (e) {
      if (e instanceof NftLaunchError) return e.code;
      assert(e instanceof ContractFunctionExecutionError && !isContractAnswer(e), `the node's own error reaches the caller: ${String(e)}`);
      return "rpc-error";
    }
  };
  for (const multicall of [false, true]) {
    assert.equal(await run(nftNode("http500", { result: word(owner) }, multicall)), "rpc-error");
    assert.equal(await run(nftNode(yes, { error: { code: 429, message: "Too Many Requests" } }, multicall)), "rpc-error");
    assert.equal(await run(nftNode({ error: { code: 3, message: "execution reverted", data: "0x" } }, { result: word(owner) }, multicall)), "NFT_NOT_ERC721",
      "a contract that reverts is still refused as not an ERC-721");
    assert.equal(await run(nftNode(yes, { error: { code: 3, message: "execution reverted", data: revertString("ERC721: invalid token ID") } }, multicall)), "NFT_NOT_CONTROLLED");
  }
});

// ---- registration: the registration harness of tests/launch-service.test.ts, with NFT drafts -----------------------------------
// NFT calldata needs a deployed vault factory; this file runs in its own process, and the committed manifest is restored afterwards.
const committed4663 = NFT_VAULT_MANIFEST.chains["4663"];
NFT_VAULT_MANIFEST.chains["4663"] = { status: "deployed_verified", factory: "0x00000000000000000000000000000000000fac70",
  factoryRuntimeHash: keccak256("0x6001"), transactionHash: `0x${"11".repeat(32)}`, blockNumber: 1 };
after(() => { NFT_VAULT_MANIFEST.chains["4663"] = committed4663; });

const creator = owner, treasury = "0x2222222222222222222222222222222222222222" as Address;
const blockHash = `0x${"bb".repeat(32)}` as Hex, usdg = LAUNCH_FEE_STABLE[4663]!, FEE_BLOCK = LAUNCH_FEE_MIN_BLOCK[4663]! + 10n;
const plainNft = { chainId: 4663 as const, contract: getAddress("0x7777777777777777777777777777777777777777"), tokenId: "7" };
type Coin = ReturnType<typeof coin>;
/** One launch: frozen preview, outer transaction and receipt, as in launch-service.test.ts's ordinary fixture. */
function coin(n: number, draftOver: Record<string, unknown>, creator: Address = owner) {
  const token = getAddress(`0x${String(n).repeat(40)}`), hash = `0x${String(n).repeat(64)}` as Hex;
  const sdk = new DopplerSDK<4663>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }), chainId: 4663 });
  const draft = { name: `Coin ${n}`, symbol: `COIN${n}`, description: "", image: "", quoteAddress: musegod.address, tradingFeeBps: 100, nft: muse, ...draftOver } as LaunchPlan["draft"];
  const openingValuation = syntheticOpeningValuation(draft.quoteAddress, "3000", { chainId: 4663 });
  const createParams = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, draft, creator, treasury, treasury, openingValuation, undefined, 4663));
  const poolKey = { currency0: token, currency1: draft.quoteAddress, fee: 8388608, tickSpacing: 10, hooks: contracts.initializer };
  const data = encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [createParams] });
  const prepared = { chainId: 4663 as const, account: creator, airlock: contracts.airlock, createParams,
    prediction: { tokenAddress: token, poolOrHookAddress: token, governanceAddress: treasury, timelockAddress: treasury, poolKey, poolId: computePoolId(poolKey), tokenIsCurrency0: true },
    transaction: { to: contracts.airlock, data, value: 0n }, gasEstimate: { status: "unavailable" as const } };
  const plan: LaunchPlan = { id: keccak256(data), creator, data, tokenAddress: token, poolId: prepared.prediction.poolId, draft, preparedAt: Date.now(), gas: null,
    feePolicy: FEE_POLICY, feeTreasury: treasury, openingValuation, curvePolicy: CURVE_POLICY, prepared: serializePrepared(prepared),
    transaction: { to: contracts.airlock, data, value: "0" } };
  const receipt = { status: "success", from: creator, to: contracts.airlock, transactionHash: hash, blockHash, blockNumber: 10n, logs: [
    { address: contracts.airlock, topics: encodeEventTopics({ abi: airlockAbi, eventName: "Create", args: { numeraire: draft.quoteAddress } }),
      data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [token, contracts.initializer, token]) },
    { address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: zeroAddress, to: contracts.airlock } }),
      data: encodeAbiParameters([{ type: "uint256" }], [SUPPLY]) },
    { address: contracts.rehype, topics: encodeEventTopics({ abi: rehypeDopplerHookInitializerAbi, eventName: "FeeScheduleSet", args: { poolId: plan.poolId } }),
      data: encodeAbiParameters([{ type: "uint32" }, { type: "uint24" }, { type: "uint24" }, { type: "uint32" }], [1, 10_000, 10_000, 0]) },
  ] };
  return { token, hash, plan, poolKey, receipt, tx: { hash, from: creator, to: contracts.airlock, input: data, value: 0n } };
}
/** The calldata of a real payer's USDG payment: transfer(treasury, 10 USDG), sent to USDG. */
const usdgTransfer = (to: Address = treasury, amount: bigint = usdg.amount) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
/** An exact 10 USDG payment from the creator to the treasury. */
const feePayment = (hash: Hex) => ({ status: "success", transactionHash: hash, blockNumber: FEE_BLOCK, blockHash, from: creator, logs: [{ address: usdg.address,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: creator, to: treasury } }), data: encodeAbiParameters([{ type: "uint256" }], [usdg.amount]) }] });

/** `payments`: fee transactions the chain knows (by default a real payer's USDG transfer); any other hash has neither a transaction nor a
 * receipt. `feeFault`: a known payment is still in the mempool (no receipt yet), mined with one confirmation, in a reorganized block, or
 * its receipt read fails at the node.
 * `feeReceipt` / `feeTx`: fields that replace those of the exact payment (a definite mismatch). `quoteKey`: the ETH quote key. */
type Chain = { holder?: Address | "fail"; receiptAge?: bigint; delayMs?: number; payments?: Hex[]; feeFault?: "mempool" | "unconfirmed" | "reorganized" | "rpc";
  feeReceipt?: Record<string, unknown>; feeTx?: Record<string, unknown>; quoteKey?: string;
  /** Creations not mined yet: the node knows the transaction but has no receipt. */
  unmined?: Hex[];
  /** Creations the node has no trace of (evicted or replaced): neither the transaction nor a receipt. */
  untraced?: Hex[] };
/** The service with the registration harness's stubs. Every NFT read is logged with the block it asked for ("latest" when none). */
function registrar(store: Store, coins: Coin[], chain: Chain = {}) {
  const reads: string[] = [], now = BigInt(Math.floor(Date.now() / 1000));
  const byHash = (hash: Hex) => coins.find((c) => c.hash.toLowerCase() === hash.toLowerCase());
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
    runtime: { config: { mode: "fork", chainId: 31337, deploymentChainId: 4663, writesEnabled: false, treasury },
      secrets: chain.quoteKey ? { planAttestationKey: chain.quoteKey } : {} },
    store, assertNetwork: async () => {},
    client: {
      getTransaction: async ({ hash }: { hash: Hex }) => {
        const found = byHash(hash);
        if (found && chain.untraced?.includes(found.hash)) throw new TransactionNotFoundError({ hash });
        if (found) return found.tx;
        if (chain.payments?.some((paid) => paid.toLowerCase() === hash.toLowerCase()))
          return { hash, from: creator, to: usdg.address, input: usdgTransfer(), value: 0n, ...chain.feeTx };
        throw new TransactionNotFoundError({ hash });
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const found = byHash(hash);
        if (found && (chain.unmined?.includes(found.hash) || chain.untraced?.includes(found.hash))) throw new TransactionReceiptNotFoundError({ hash });
        if (found) return found.receipt;
        if (chain.payments?.some((paid) => paid.toLowerCase() === hash.toLowerCase())) {
          if (chain.feeFault === "rpc") throw new HttpRequestError({ url: "https://rpc.fixture.test", status: 503 });
          if (chain.feeFault === "mempool") throw new TransactionReceiptNotFoundError({ hash });
          return { ...feePayment(hash), ...(chain.feeFault === "reorganized" ? { blockHash: `0x${"cc".repeat(32)}` } : {}), ...chain.feeReceipt };
        }
        throw new TransactionReceiptNotFoundError({ hash });
      },
      getBlockNumber: async () => chain.feeFault === "unconfirmed" ? FEE_BLOCK : FEE_BLOCK + 100n,
      // Any block, including the head (`blockTag: "latest"`), is `receiptAge` seconds old; the first coin's valuation block keeps its own hash.
      getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => {
        const valuation = coins[0]?.plan.openingValuation;
        return { hash: valuation && blockNumber === BigInt(valuation.blockNumber) ? valuation.blockHash : blockHash, timestamp: now - (chain.receiptAge ?? 30n) };
      },
      readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
        if (!["supportsInterface", "ownerOf", "checkDelegateForERC721"].includes(functionName)) throw new Error("No independent reference in this fixture");
        reads.push(`${functionName}:${blockNumber ?? "latest"}`);
        if (chain.delayMs) await new Promise((resolve) => setTimeout(resolve, chain.delayMs));
        if (chain.holder === "fail") throw new Error("rpc down");
        return functionName === "supportsInterface" ? true : functionName === "ownerOf" ? chain.holder ?? creator : false;
      },
      getCode: async () => undefined,
    },
    // A real SDK (backups are re-encoded through it) whose pool reads are stubbed, as in the recovery harness.
    sdk: Object.assign(new DopplerSDK<4663>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }), chainId: 4663 }), {
      getMulticurvePool: async (address: Address) => ({ getState: async () => {
        const found = coins.find((c) => c.token === address)!;
        return { status: 2, numeraire: found.plan.draft.quoteAddress, poolKey: found.poolKey };
      } }) }),
  }) as LaunchpadService;
  return { service, reads };
}
function withStore(run: (store: Store) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "nft-register-")), store = new Store(directory, 31337);
    try { await run(store); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}

test("a saved Muse preview whose creator still holds the NFT registers verified, read at the latest block only", withStore(async (store) => {
  const first = coin(3, {});
  store.savePlan(first.plan);
  const { service, reads } = registrar(store, [first]);
  const record = await service.register(first.hash);
  assert.deepEqual(record.nftVerification, { status: "verified" });
  assert.deepEqual(record.nft, first.plan.draft.nft);
  assert.equal(record.launchFee, undefined);
  assert(reads.length > 0 && reads.every((read) => read.endsWith(":latest")), `no historical-state read for a saved preview: ${reads}`);
  const before = reads.length;
  assert.deepEqual((await service.register(first.hash)).nftVerification, { status: "verified" });
  assert.equal(reads.length, before, "a stored status is reused, never decided again");
}));

test("a second coin for the same NFT registers rejected: already_launched; the first keeps its badge", withStore(async (store) => {
  const first = coin(3, {}), second = coin(4, {});
  store.savePlan(first.plan); store.savePlan(second.plan);
  const { service } = registrar(store, [first, second]);
  await service.register(first.hash);
  const loser = await service.register(second.hash);
  assert.equal(loser.nftVerification?.status, "rejected"); assert.equal(loser.nftVerification?.reason, "already_launched");
  assert.equal(loser.address, second.token, "it still registers");
  assert.equal(store.verifiedNftCoin(nftKey(muse))?.address, first.token);
}));

test("concurrent registrations of two coins for one NFT verify exactly one (the lock holds through the write)", withStore(async (store) => {
  const coins = [coin(3, {}), coin(4, {}), coin(5, {})];
  for (const c of coins) store.savePlan(c.plan);
  const { service } = registrar(store, coins, { delayMs: 5 });
  const records = await Promise.all(coins.map((c) => service.register(c.hash)));
  assert.equal(records.filter((r) => r.nftVerification?.status === "verified").length, 1);
  assert.equal(records.filter((r) => r.nftVerification?.reason === "already_launched").length, 2);
  // A rebuilt service (refreshRuntime) shares the same module-level locks.
  const more = [coin(6, { nft: { ...muse, tokenId: "2" } }), coin(7, { nft: { ...muse, tokenId: "2" } })];
  for (const c of more) store.savePlan(c.plan);
  const pair = await Promise.all(more.map((c) => registrar(store, [...coins, ...more], { delayMs: 5 }).service.register(c.hash)));
  assert.deepEqual(pair.map((r) => r.nftVerification?.status).sort(), ["rejected", "verified"]);
}));

test("only a verified launch fee persists: an unpaid claim is dropped and the coin is rejected: fee", withStore(async (store) => {
  // A mined, canonical transfer of 9.999999 USDG: a definite mismatch.
  const claim = { asset: "stable" as const, txHash: `0x${"ee".repeat(32)}` as Hex };
  const unpaid = coin(3, { nft: plainNft, quoteAddress: weth.address, launchFee: claim });
  store.savePlan(unpaid.plan);
  const { service, reads } = registrar(store, [unpaid], { payments: [claim.txHash], feeReceipt: { logs: [{ address: usdg.address,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: creator, to: treasury } }), data: encodeAbiParameters([{ type: "uint256" }], [usdg.amount - 1n]) }] } });
  const record = await service.register(unpaid.hash);
  assert.equal(record.nftVerification?.reason, "fee");
  assert.equal("launchFee" in record, false, "the draft's unverified fee never reaches the record");
  assert.equal(store.tokenUsingLaunchFee(claim.txHash, creator), null, "so it consumes nobody's payment");
  assert.equal(reads.length, 0, "a fee rejection needs no control read");
}));

test("a verified fee persists (lower-case hash) and is single-use across concurrent coins for different NFTs", withStore(async (store) => {
  const paid = `0x${"Ab".repeat(32)}` as Hex, fee = { asset: "stable" as const, txHash: paid.toLowerCase() as Hex };
  const a = coin(3, { nft: plainNft, quoteAddress: weth.address, launchFee: fee });
  const b = coin(4, { nft: { ...plainNft, tokenId: "8" }, quoteAddress: weth.address, launchFee: fee });
  store.savePlan(a.plan); store.savePlan(b.plan);
  const { service } = registrar(store, [a, b], { payments: [paid], delayMs: 5 });
  const records = await Promise.all([service.register(a.hash), service.register(b.hash)]);
  const winner = records.find((r) => r.nftVerification?.status === "verified")!, loser = records.find((r) => r !== winner)!;
  assert(winner && loser, "exactly one coin spends the payment");
  assert.deepEqual(winner.launchFee, fee);
  assert.equal(loser.nftVerification?.reason, "fee"); assert.equal(loser.launchFee, undefined);
  assert.equal(store.tokenUsingLaunchFee(paid.toUpperCase().replace("0X", "0x"), creator)?.address, winner.address);
}));

test("an RPC outage fails registration retryably for 10 minutes, then records unverified", withStore(async (store) => {
  const first = coin(3, {});
  store.savePlan(first.plan);
  await assert.rejects(() => registrar(store, [first], { holder: "fail", receiptAge: 30n }).service.register(first.hash), /temporarily unavailable/);
  assert.equal(store.tokenByTxHash(first.hash), null, "nothing is written while a retry is still useful");
  const late = await registrar(store, [first], { holder: "fail", receiptAge: 601n }).service.register(first.hash);
  assert.deepEqual(late.nftVerification, { status: "unverified", reason: "rpc" });
  const { service, reads } = registrar(store, [first]);
  assert.deepEqual((await service.register(first.hash)).nftVerification, { status: "unverified", reason: "rpc" }, "only the operator CLI settles it");
  assert.equal(reads.length, 0);
}));

const paidFee = `0x${"cd".repeat(32)}` as Hex, stableClaim = { asset: "stable" as const, txHash: paidFee };
const upper = (value: Hex) => value.toUpperCase().replace("0X", "0x") as Hex;
/** A paid-NFT launch (its own token id, so no one-coin interplay) whose draft claims `fee`. */
const feeLaunch = (n: number, tokenId: string, fee: LaunchPlan["draft"]["launchFee"] = stableClaim) =>
  coin(n, { nft: { ...plainNft, tokenId }, quoteAddress: weth.address, launchFee: fee });

test("inside 10 minutes every transient fee case retries: a hash never seen, a payment in the mempool, confirming or reorganized, a failed read", withStore(async (store) => {
  const cases: [string, Chain][] = [["never seen", { payments: [] }], ["in the mempool", { payments: [paidFee], feeFault: "mempool" }],
    ["one confirmation", { payments: [paidFee], feeFault: "unconfirmed" }], ["reorganized block", { payments: [paidFee], feeFault: "reorganized" }],
    ["node failure", { payments: [paidFee], feeFault: "rpc" }]];
  for (const [index, [why, chain]] of cases.entries()) {
    const launch = feeLaunch(3 + index, String(10 + index));
    store.savePlan(launch.plan);
    await assert.rejects(() => registrar(store, [launch], { ...chain, receiptAge: 30n }).service.register(launch.hash),
      /The launch fee check is temporarily unavailable\. Registration will retry\./, why);
    assert.equal(store.tokenByTxHash(launch.hash), null, `${why}: nothing is written while a retry is still useful`);
  }
}));

test("after 10 minutes a fee transaction that cannot be found at all is rejected: fee, and the coin is never listed for the NFT", withStore(async (store) => {
  const fake = feeLaunch(3, "30", { asset: "stable", txHash: `0x${"de".repeat(32)}` });
  store.savePlan(fake.plan);
  const record = await registrar(store, [fake], { payments: [paidFee], receiptAge: 601n }).service.register(fake.hash);
  assert.deepEqual(record.nftVerification, { status: "rejected", reason: "fee" });
  assert.equal(record.launchFee, undefined);
  assert.equal(isBoundNftCoin(record), false, "not in the public ?nft= listing");
  assert.equal(listedNftCoin(record), false, "not in Explore's NFT filter");
  // The public listing itself, over HTTP.
  const directory = mkdtempSync(join(tmpdir(), "nft-register-listing-"));
  const entry = createApp(undefined, "loopback", runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory,
    PLATFORM_TREASURY: treasury, NFT_MODE_ENABLED: "true" }));
  entry.service.tokens = async () => store.tokens();
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const bound = server.address(); assert(bound && typeof bound !== "string");
  const port: number = bound.port;
  try {
    for (const query of ["any", `4663:${plainNft.contract}:30`]) {
      const listing: Response = await fetch(`http://127.0.0.1:${port}/api/tokens?nft=${query}`);
      assert.equal(listing.status, 200);
      assert.deepEqual(await listing.json(), [], query);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    entry.service.store.close(); rmSync(directory, { recursive: true, force: true });
  }
}));

test("after 10 minutes a fee that exists but is unconfirmed or reorganized, or could not be read, leaves the coin unverified with its claim, unconsumed", withStore(async (store) => {
  const cases: [string, Chain][] = [["in the mempool", { payments: [paidFee], feeFault: "mempool" }], ["one confirmation", { payments: [paidFee], feeFault: "unconfirmed" }],
    ["reorganized block", { payments: [paidFee], feeFault: "reorganized" }], ["node failure", { payments: [paidFee], feeFault: "rpc" }]];
  for (const [index, [why, chain]] of cases.entries()) {
    const launch = feeLaunch(3 + index, String(40 + index), { asset: "stable", txHash: upper(paidFee) });
    store.savePlan(launch.plan);
    const late = await registrar(store, [launch], { ...chain, receiptAge: 601n }).service.register(launch.hash);
    assert.deepEqual(late.nftVerification, { status: "unverified", reason: "fee_unconfirmed", feeClaim: stableClaim },
      `${why}: the claim (lower-case hash) is kept for nft:reverify`);
    assert.equal("launchFee" in late, false, `${why}: an unconfirmed fee is never recorded as spent`);
    assert.equal(store.tokenUsingLaunchFee(paidFee, creator), null, `${why}: the payment stays unconsumed`);
    assert.equal(isBoundNftCoin(late), true, `${why}: a real payment lagging behind is listed as unverified`);
  }
}));

test("the platform treasury missing at registration is logged, retried for 10 minutes, then recorded unverified", withStore(async (store) => {
  const launch = feeLaunch(3, "50");
  store.savePlan(launch.plan);
  const logged: string[] = [], original = console.error;
  console.error = (line: unknown) => { logged.push(String(line)); };
  try {
    const unconfigured = (age: bigint) => { const run = registrar(store, [launch], { payments: [paidFee], receiptAge: age });
      Object.assign(run.service, { runtime: { ...run.service.runtime, config: { ...run.service.runtime.config, treasury: null } } }); return run.service; };
    await assert.rejects(() => unconfigured(30n).register(launch.hash), /temporarily unavailable/);
    assert.deepEqual((await unconfigured(601n).register(launch.hash)).nftVerification, { status: "unverified", reason: "fee_unconfirmed", feeClaim: stableClaim });
  } finally { console.error = original; }
  assert.equal(logged.length, 2);
  for (const line of logged) assert.deepEqual(JSON.parse(line), { event: "nft_fee_treasury_unconfigured", transactionHash: launch.hash, token: launch.token });
}));

test("a definite fee mismatch is rejected: fee at once, even for a coin under 10 minutes old", withStore(async (store) => {
  const paid = `0x${"cd".repeat(32)}` as Hex, fee = { asset: "stable" as const, txHash: paid };
  const transfer = (to: Address, amount: bigint) => ({ address: usdg.address, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: creator, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]) });
  const cases: [string, Chain["feeReceipt"]][] = [["wrong amount", { logs: [transfer(treasury, usdg.amount + 1n)] }], ["wrong recipient", { logs: [transfer(getAddress(other), usdg.amount)] }],
    ["wrong payer", { from: other }], ["wrong asset", { logs: [{ ...transfer(treasury, usdg.amount), address: weth.address }] }], ["reverted", { status: "reverted" }],
    ["block below the minimum", { blockNumber: LAUNCH_FEE_MIN_BLOCK[4663]! - 1n }]];
  for (const [index, [why, feeReceipt]] of cases.entries()) {
    const launch = coin(3 + index, { nft: { ...plainNft, tokenId: String(20 + index) }, quoteAddress: weth.address, launchFee: fee });
    store.savePlan(launch.plan);
    const record = await registrar(store, [launch], { payments: [paid], feeReceipt, receiptAge: 30n }).service.register(launch.hash);
    assert.deepEqual(record.nftVerification, { status: "rejected", reason: "fee" }, why);
    assert.equal(record.launchFee, undefined, why);
  }
  // ETH: a quote MAC the platform never signed, and a transfer that carries calldata.
  const key = "q".repeat(32), wei = "5000000000000000", expiresAt = Math.floor(Date.now() / 1000) + 30;
  const eth = (mac: Hex) => ({ asset: "native" as const, txHash: paid, wei, expiresAt, mac });
  const ethCases: [string, Hex, Chain["feeTx"]][] = [["invalid MAC", launchFeeQuoteMac("x".repeat(32), 4663, creator, wei, expiresAt), { to: treasury, value: BigInt(wei) }],
    ["non-plain transfer", launchFeeQuoteMac(key, 4663, creator, wei, expiresAt), { to: treasury, value: BigInt(wei), input: "0xdeadbeef" }]];
  for (const [index, [why, mac, feeTx]] of ethCases.entries()) {
    const launch = coin(8 + index, { nft: { ...plainNft, tokenId: String(28 + index) }, quoteAddress: weth.address, launchFee: eth(mac) });
    store.savePlan(launch.plan);
    const record = await registrar(store, [launch], { payments: [paid], feeTx, quoteKey: key, receiptAge: 30n }).service.register(launch.hash);
    assert.deepEqual(record.nftVerification, { status: "rejected", reason: "fee" }, why);
  }
}));

test("signing re-checks one coin per NFT: a plan for an NFT that has since got its verified coin cannot be signed", withStore(async (store) => {
  const launch = coin(3, {}), rival = coin(4, {});
  store.savePlan(launch.plan);
  const { service } = registrar(store, [launch]);
  const live = { ...service.runtime.config, writesEnabled: true, nftMode: { enabled: true, vaultFactory: "0x00000000000000000000000000000000000fac70" as Address,
    launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } };
  Object.assign(service, { runtime: { ...service.runtime, config: live }, config: async () => live });
  const keys: string[] = [];
  const verifiedNftCoin = store.verifiedNftCoin.bind(store);
  store.verifiedNftCoin = (key, exclude) => { keys.push(`${key}|${exclude}`); return verifiedNftCoin(key, exclude); };
  assert.equal((await service.validateLaunch(creator, launch.plan.data)).valid, true, "a preview is not a signature: no one-coin read");
  assert.deepEqual(keys, []);
  assert.equal((await service.validateLaunch(creator, launch.plan.data, true)).valid, true, "no other verified coin yet");
  assert.deepEqual(keys, [`${nftKey(muse)}|${launch.token}`], "exactly one read, excluding this plan's own coin");
  store.saveToken(syntheticToken({ mode: "fork", address: rival.token, transactionHash: rival.hash, nft: muse, nftVerification: { status: "verified" } }));
  await assert.rejects(() => service.validateLaunch(creator, launch.plan.data, true), (error: unknown) =>
    error instanceof NftLaunchError && error.code === "NFT_ALREADY_LAUNCHED" && error.message === "This NFT already has its coin.");
}));

/** The registration harness's service, live for signing (as in the one-coin signing test above). */
function signingService(store: Store, coins: Coin[], chain: Chain = {}) {
  const { service } = registrar(store, coins, chain);
  const live = { ...service.runtime.config, writesEnabled: true, nftMode: { enabled: true, vaultFactory: "0x00000000000000000000000000000000000fac70" as Address,
    launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } };
  Object.assign(service, { runtime: { ...service.runtime, config: live }, config: async () => live });
  return service;
}
const signingCode = (work: Promise<unknown>) => work.then(() => "ok", (error: unknown) => error instanceof NftLaunchError ? `${error.code}: ${error.message}` : `other: ${String(error)}`);
const IN_PROGRESS = "NFT_LAUNCH_IN_PROGRESS: A launch for this NFT is already being signed. Finish it or wait a few minutes.";
const FEE_IN_USE = "NFT_FEE_IN_USE: This launch fee is already attached to another launch being signed.";

test("signing claims the NFT: another plan for it is refused while the first is being signed, and the first can sign again", withStore(async (store) => {
  const first = coin(3, {}), second = coin(4, {});
  store.savePlan(first.plan); store.savePlan(second.plan);
  // Two runtimes (two tabs reaching different processes) share only the database.
  const one = signingService(store, [first, second]), other = signingService(store, [first, second]);
  assert.equal(await signingCode(one.validateLaunch(creator, first.plan.data, true)), "ok");
  assert.equal(await signingCode(other.validateLaunch(creator, second.plan.data, true)), IN_PROGRESS);
  assert.equal(await signingCode(other.validateLaunch(creator, first.plan.data, true)), "ok", "the same plan keeps its claim, from any runtime");
  assert.equal(await signingCode(other.validateLaunch(creator, second.plan.data)), "ok", "a preview is not a signature: it claims nothing and is never refused");
  // The refused plan was never protected for signing.
  assert.deepEqual((store.db.prepare("SELECT id FROM protected_plans ORDER BY id").all() as { id: string }[]).map((row) => row.id), [first.plan.id]);
}));

test("claims follow a plan's verified lineage: the plan signed after a first-buy approval, also after a re-confirmed price, takes them over; an independent prepare with the same intent and a racing sibling do not", withStore(async (store) => {
  const approved = coin(3, {}), reconfirm = coin(4, {}), signed = coin(5, {}), sibling = coin(6, {}), independent = coin(7, {});
  for (const c of [approved, reconfirm, signed, sibling, independent]) c.plan.intentId = "intent-one-0001";
  // As prepare stores them: the refresh after the approval needed a re-confirmed price (never signed), the re-confirmed plan refreshes it,
  // and another tab refreshed the approved plan too. The independent plan reuses the intent without a previousPlanId.
  reconfirm.plan.previousPlanId = approved.plan.id; signed.plan.previousPlanId = reconfirm.plan.id; sibling.plan.previousPlanId = approved.plan.id;
  for (const c of [approved, reconfirm, signed, sibling, independent]) store.savePlan(c.plan);
  const service = signingService(store, [approved, reconfirm, signed, sibling, independent]);
  assert.equal(await signingCode(service.validateLaunch(creator, approved.plan.data, true)), "ok", "the approval signs under the first plan");
  assert.equal(await signingCode(service.validateLaunch(creator, independent.plan.data, true)), IN_PROGRESS, "the same intent without a lineage is another launch");
  assert.equal(await signingCode(service.validateLaunch(creator, signed.plan.data, true)), "ok", "the re-confirmed refresh takes the claim through its lineage");
  assert.equal(await signingCode(service.validateLaunch(creator, sibling.plan.data, true)), IN_PROGRESS, "a racing child of the earlier plan loses");
  assert.equal(await signingCode(service.validateLaunch(creator, approved.plan.data, true)), IN_PROGRESS, "and the earlier plan no longer holds it");
  assert.equal((await service.register(signed.hash)).nftVerification?.status, "verified");
  assert.equal(await signingCode(service.validateLaunch(creator, independent.plan.data, true)), "NFT_ALREADY_LAUNCHED: This NFT already has its coin.",
    "registration freed the claim; the one-coin rule answers");
}));

test("a lineage counts only through plans with the same creator, NFT and fee", withStore(async (store) => {
  const first = `0x${"c1".repeat(32)}` as Hex, second = `0x${"c2".repeat(32)}` as Hex, nft = { ...plainNft, tokenId: "50" };
  const parent = coin(3, { nft, quoteAddress: weth.address, launchFee: { asset: "stable" as const, txHash: first } });
  const child = coin(4, { nft, quoteAddress: weth.address, launchFee: { asset: "stable" as const, txHash: second } });
  child.plan.previousPlanId = parent.plan.id;
  store.savePlan(parent.plan); store.savePlan(child.plan);
  const service = signingService(store, [parent, child], { payments: [first, second] });
  assert.equal(await signingCode(service.validateLaunch(creator, parent.plan.data, true)), "ok");
  assert.equal(await signingCode(service.validateLaunch(creator, child.plan.data, true)), IN_PROGRESS, "a stored parent with another fee is not its lineage");
}));

test("signing claims the launch fee: another NFT's plan reusing the payment is refused, in any case of the hash", withStore(async (store) => {
  const paid = `0x${"cd".repeat(32)}` as Hex, fee = { asset: "stable" as const, txHash: paid };
  const first = coin(3, { nft: { ...plainNft, tokenId: "40" }, quoteAddress: weth.address, launchFee: fee });
  const second = coin(4, { nft: { ...plainNft, tokenId: "41" }, quoteAddress: weth.address, launchFee: { ...fee, txHash: `0x${"CD".repeat(32)}` as Hex } });
  store.savePlan(first.plan); store.savePlan(second.plan);
  const service = signingService(store, [first, second], { payments: [paid] });
  assert.equal(await signingCode(service.validateLaunch(creator, first.plan.data, true)), "ok");
  assert.equal(await signingCode(service.validateLaunch(creator, second.plan.data, true)), FEE_IN_USE);
  // Nothing of the refused plan was claimed: its NFT is still free for a plan with another fee.
  assert.deepEqual(store.claimLaunch(`0x${"ee".repeat(32)}`, [`nft:${nftKey(second.plan.draft.nft!)}`], Date.now() + 60_000), []);
}));

test("signing re-checks the fee after claiming it: a payment another coin has spent cannot be signed", withStore(async (store) => {
  const paid = `0x${"cd".repeat(32)}` as Hex, fee = { asset: "stable" as const, txHash: paid };
  const launch = coin(3, { nft: { ...plainNft, tokenId: "42" }, quoteAddress: weth.address, launchFee: fee }), spender = coin(4, {});
  store.savePlan(launch.plan);
  const service = signingService(store, [launch], { payments: [paid] });
  assert.equal(await signingCode(service.validateLaunch(creator, launch.plan.data, true)), "ok", "an unused payment signs");
  store.saveToken(syntheticToken({ mode: "fork", address: spender.token, transactionHash: spender.hash, creator, launchFee: fee }));
  assert.equal(await signingCode(service.validateLaunch(creator, launch.plan.data, true)), "NFT_FEE_USED: This launch fee was already used.");
}));

test("registration holds a plan's claims while it decides, then releases them whatever the status, and is never blocked by another plan's claim", withStore(async (store) => {
  const first = coin(3, {}), second = coin(4, {}), third = coin(5, { nft: { ...muse, tokenId: "2" } });
  const stranger = `0x${"ee".repeat(32)}`, key = `nft:${nftKey(muse)}`, later = () => Date.now() + 60_000;
  for (const c of [first, second, third]) store.savePlan(c.plan);
  const service = signingService(store, [first, second]);
  const released: string[] = [], release = store.releaseLaunchClaims.bind(store);
  store.releaseLaunchClaims = (owner, options) => { released.push(owner); release(owner, options); };
  const logged: string[] = [], original = console.error;
  console.error = (line: string) => { logged.push(line); };
  try {
    assert.equal(await signingCode(service.validateLaunch(creator, first.plan.data, true)), "ok");
    // A coin launched without this server's claim (a backup, an older build) registers while the first plan holds the NFT.
    assert.equal((await service.register(second.hash)).nftVerification?.status, "verified");
    assert.deepEqual(store.claimLaunch(stranger, [key], later()), [key], "another plan's claim is left alone");
    assert.equal((await service.register(first.hash)).nftVerification?.reason, "already_launched");
    assert.deepEqual(released, [second.plan.id, first.plan.id]);
    assert.deepEqual(store.claimLaunch(stranger, [key], later()), [], "the rejected launch's claim was released");
    // A release that fails only leaves the claims to expire: registration still completes.
    store.releaseLaunchClaims = () => { throw new Error("database down"); };
    assert.equal((await registrar(store, [third]).service.register(third.hash)).nftVerification?.status, "verified");
  } finally { console.error = original; }
  assert.deepEqual(logged.map((line) => JSON.parse(line)), [
    { event: "nft_launch_claim_lost", planId: second.plan.id, hash: second.hash, held: [key] },
    { event: "nft_launch_claims_release_failed", planId: third.plan.id, error: "database down" }]);
}));

test("a sent creation keeps its claims past the signing window: never taken over or transferred, until registration", withStore(async (store) => {
  const sent = coin(3, {});
  store.savePlan(sent.plan);
  const service = signingService(store, [sent]);
  assert.equal(await signingCode(service.validateLaunch(creator, sent.plan.data, true)), "ok");
  await service.trackLaunch(sent.hash, sent.plan.id);
  // More than one signing window later: an independent plan, and a refresh of the sent plan, for the same NFT.
  const now = Date.now, shifted = now() + LAUNCH_SIGNING_TTL + 1_000;
  let later: Coin[] = [];
  Date.now = () => shifted;
  try {
    const independent = coin(4, {}), refresh = coin(5, {});
    refresh.plan.previousPlanId = sent.plan.id;
    later = [independent, refresh];
    for (const c of later) store.savePlan(c.plan);
    const rival = signingService(store, later);
    assert.equal(await signingCode(rival.validateLaunch(creator, independent.plan.data, true)), IN_PROGRESS, "a submitted claim is not taken over");
    assert.equal(await signingCode(rival.validateLaunch(creator, refresh.plan.data, true)), IN_PROGRESS, "nor transferred down its lineage");
  } finally { Date.now = now; }
  assert.equal((await service.register(sent.hash)).nftVerification?.status, "verified");
  assert.deepEqual(store.claimLaunch(later[0].plan.id, [`nft:${nftKey(muse)}`], Date.now() + 60_000), [], "registration released the submitted claim");
}));

test("a creation reconcile proves reverted releases its submitted claims", withStore(async (store) => {
  const reverted = coin(3, {}), next = coin(4, {});
  reverted.receipt.status = "reverted";
  store.savePlan(reverted.plan); store.savePlan(next.plan);
  const service = signingService(store, [reverted, next]);
  assert.equal(await signingCode(service.validateLaunch(creator, reverted.plan.data, true)), "ok");
  await service.trackLaunch(reverted.hash, reverted.plan.id);
  assert.equal(await signingCode(service.validateLaunch(creator, next.plan.data, true)), IN_PROGRESS, "held while the creation is pending");
  await service.reconcile();
  assert.equal(store.pendingLaunches().length, 0, "the reverted creation left the queue");
  assert.equal((store.db.prepare("SELECT status FROM pending_launches WHERE hash=?").get(reverted.hash) as { status: string }).status, "failed");
  assert.equal(claimRow(store, museClaim), undefined, "released");
  await service.reconcile();
  assert.equal(claimRow(store, museClaim), undefined, "and never renewed afterwards");
  assert.equal(await signingCode(service.validateLaunch(creator, next.plan.data, true)), "ok", "its NFT is free again");
}));

test("a re-check that fails after the claim releases it at once, for a spent fee and for a transient failure; a submitted claim stays", withStore(async (store) => {
  const fee = (n: string) => ({ asset: "stable" as const, txHash: `0x${n.repeat(32)}` as Hex }), nft = (tokenId: string) => ({ ...plainNft, tokenId });
  const draft = (tokenId: string, n: string) => ({ nft: nft(tokenId), quoteAddress: weth.address, launchFee: fee(n) });
  const spent = coin(3, draft("60", "d1")), fresh = coin(4, draft("60", "d2")), flaky = coin(5, draft("61", "d3")), retry = coin(6, draft("61", "d4"));
  const sent = coin(7, draft("62", "d5")), rival = coin(8, draft("62", "d6")), spender = coin(9, {});
  const all = [spent, fresh, flaky, retry, sent, rival];
  for (const c of all) store.savePlan(c.plan);
  const payments = ["d1", "d2", "d3", "d4", "d5", "d6"].map((n) => fee(n).txHash);
  const service = signingService(store, all, { payments }), failing = signingService(store, all, { payments, feeFault: "rpc" });
  // A fee another coin already spent.
  store.saveToken(syntheticToken({ mode: "fork", address: spender.token, transactionHash: spender.hash, creator, launchFee: fee("d1") }));
  assert.equal(await signingCode(service.validateLaunch(creator, spent.plan.data, true)), "NFT_FEE_USED: This launch fee was already used.");
  assert.equal(await signingCode(service.validateLaunch(creator, fresh.plan.data, true)), "ok", "its NFT was released at once, for a plan with an unused fee");
  // A fee read that fails at the node.
  assert.match(await signingCode(failing.validateLaunch(creator, flaky.plan.data, true)), /^other: /);
  assert.equal(await signingCode(service.validateLaunch(creator, retry.plan.data, true)), "ok", "a transient failure releases it too");
  // A sent creation re-validated during an outage keeps its submitted claim.
  assert.equal(await signingCode(service.validateLaunch(creator, sent.plan.data, true)), "ok");
  await service.trackLaunch(sent.hash, sent.plan.id);
  assert.match(await signingCode(failing.validateLaunch(creator, sent.plan.data, true)), /^other: /);
  assert.equal(await signingCode(service.validateLaunch(creator, rival.plan.data, true)), IN_PROGRESS);
}));

const museClaim = `nft:${nftKey(muse)}`;
/** The stored claim row for one key (SQLite). */
const claimRow = (store: Store, claim: string) => {
  const row = store.db.prepare("SELECT owner, expires_at AS expiresAt, submitted FROM launch_claims WHERE claim=?").get(claim) as
    { owner: string; expiresAt: number; submitted: number } | undefined;
  return row ? { ...row } : undefined;
};

test("a non-holder's backup with a missing fee never claims a free NFT, including retries and reconcile", withStore(async (store) => {
  const backup = coin(3, { nft: { ...plainNft, tokenId: "95" }, quoteAddress: weth.address, launchFee: stableClaim }, getAddress(other));
  const holderLaunch = feeLaunch(4, "95", { asset: "stable", txHash: `0x${"d2".repeat(32)}` });
  const key = `nft:${nftKey(backup.plan.draft.nft!)}`;
  const service = registrar(store, [backup], { holder: creator }).service;
  await assert.rejects(service.register(backup.hash, structuredClone(backup.plan)), /temporarily unavailable/);
  assert.equal(claimRow(store, key), undefined, "an untrusted backup cannot insert a claim");
  await assert.rejects(service.register(backup.hash), /temporarily unavailable/);
  await service.reconcile();
  assert.equal(claimRow(store, key), undefined, "a stored recovered plan cannot insert either");
  store.savePlan(holderLaunch.plan);
  assert.equal(await signingCode(signingService(store, [holderLaunch], { payments: [holderLaunch.plan.draft.launchFee!.txHash] })
    .validateLaunch(creator, holderLaunch.plan.data, true)), "ok", "the holder signs immediately");
  await assert.rejects(service.register(backup.hash), /temporarily unavailable/);
  assert.equal(claimRow(store, key)?.owner, holderLaunch.plan.id, "a backup cannot take the holder's claim");
}));

test("a recovered backup renews only the claims its plan already owns", withStore(async (store) => {
  const backup = feeLaunch(3, "96"), key = `nft:${nftKey(backup.plan.draft.nft!)}`, t0 = Date.now();
  store.claimLaunch(backup.plan.id, [key], t0 + 60_000);
  await at(t0, async () => {
    await assert.rejects(registrar(store, [backup]).service.register(backup.hash, structuredClone(backup.plan)), /temporarily unavailable/);
  });
  assert.deepEqual(claimRow(store, key), { owner: backup.plan.id, expiresAt: t0 + 600_000, submitted: 1 });
  assert.equal(claimRow(store, `fee:${backup.plan.draft.launchFee!.txHash}`), undefined, "no missing fee claim is inserted");
}));
/** Runs `work` with Date.now fixed at `time`. */
async function at<T>(time: number, work: () => Promise<T>): Promise<T> {
  const now = Date.now;
  Date.now = () => time;
  try { return await work(); } finally { Date.now = now; }
}

test("a plan protection that fails after the claim releases it at once", withStore(async (store) => {
  const launch = coin(3, {}), other = coin(4, {});
  store.savePlan(launch.plan); store.savePlan(other.plan);
  const service = signingService(store, [launch, other]), protect = store.protectPlan.bind(store);
  store.protectPlan = () => { throw new Error("database down"); };
  assert.equal(await signingCode(service.validateLaunch(creator, launch.plan.data, true)), "other: Error: database down");
  assert.equal(claimRow(store, museClaim), undefined, "the claim was released");
  store.protectPlan = protect;
  assert.equal(await signingCode(service.validateLaunch(creator, other.plan.data, true)), "ok", "another plan signs at once");
}));

test("tracking retries a failed submitted mark and succeeds once it is stored", withStore(async (store) => {
  const sent = coin(3, {});
  store.savePlan(sent.plan);
  const service = signingService(store, [sent]), claim = store.claimLaunch.bind(store);
  assert.equal(await signingCode(service.validateLaunch(creator, sent.plan.data, true)), "ok");
  let failures = 1, marks = 0;
  store.claimLaunch = (owner, claims, expiresAt, options) => {
    if (options?.submitted && (marks++, failures-- > 0)) throw new Error("database down");
    return claim(owner, claims, expiresAt, options);
  };
  await service.trackLaunch(sent.hash, sent.plan.id);
  assert.equal(marks, 2, "one retry");
  assert.equal(claimRow(store, museClaim)?.submitted, 1);
}));

test("tracking fails retryably when the submitted mark cannot be stored, never reporting success over a signing claim; reconcile then holds the queued creation", withStore(async (store) => {
  const sent = coin(3, {});
  store.savePlan(sent.plan);
  const service = signingService(store, [sent], { unmined: [sent.hash] }), claim = store.claimLaunch.bind(store);
  assert.equal(await signingCode(service.validateLaunch(creator, sent.plan.data, true)), "ok");
  let marks = 0;
  store.claimLaunch = (owner, claims, expiresAt, options) => {
    if (options?.submitted) { marks++; throw new Error("database down"); }
    return claim(owner, claims, expiresAt, options);
  };
  const logged: string[] = [], original = console.error;
  console.error = (line: string) => { logged.push(line); };
  try {
    await assert.rejects(service.trackLaunch(sent.hash, sent.plan.id), (error: unknown) => error instanceof LaunchClaimUnavailable &&
      error.message === "The transaction is queued, but its NFT reservation could not be saved yet. Try again.");
  } finally { console.error = original; }
  assert.equal(marks, 3, "a bounded number of attempts");
  assert.deepEqual(logged.map((line) => JSON.parse(line)), [{ event: "nft_launch_claim_submit_failed", planId: sent.plan.id, hash: sent.hash, error: "database down" }]);
  assert.deepEqual(store.pendingLaunches().map((row) => row.hash), [sent.hash], "the hash is queued");
  assert.equal(claimRow(store, museClaim)?.submitted, 0, "so far only a signing claim");
  store.claimLaunch = claim;
  await service.reconcile();
  assert.equal(claimRow(store, museClaim)?.submitted, 1, "the next reconcile pass holds it as submitted");
}));

// Round 4 F6: the client aborts /launch/track after 35 s (src/lib/api.ts) and retries only a 503 it receives, so tracking must answer first.
test("tracking answers its 503 within 20 s of its start even when every submitted mark hangs or times out, well inside the client's 35 s abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  // `attempt`: what one submitted mark does — never answer (a hung request), or fail after Supabase's own 15 s timeout.
  for (const [why, attempt, expectedMarks] of [["hung", () => new Promise<string[]>(() => {}), 1],
    ["15 s timeout", () => new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error("The operation was aborted due to timeout")), 15_000)), 2]] as const) {
    const directory = mkdtempSync(join(tmpdir(), "nft-track-budget-")), store = new Store(directory, 31337);
    const original = console.error;
    console.error = () => {};
    try {
      const sent = coin(3, {});
      store.savePlan(sent.plan);
      const service = signingService(store, [sent]), claim = store.claimLaunch.bind(store);
      let marks = 0;
      store.claimLaunch = ((owner, claims, expiresAt, options) => {
        if (options?.submitted) { marks++; return attempt(); }
        return claim(owner, claims, expiresAt, options);
      }) as Store["claimLaunch"];
      const started = Date.now();
      let settled: unknown = "open";
      const outcome = (): unknown => settled;
      service.trackLaunch(sent.hash, sent.plan.id).then(() => { settled = "ok"; }, (error: unknown) => { settled = error; });
      for (let second = 0; second < 19; second++) { await flush(); t.mock.timers.tick(1_000); }
      await flush();
      assert.equal(outcome(), "open", `${why}: still trying before the budget ends`);
      for (let second = 19; second < 21 && outcome() === "open"; second++) { t.mock.timers.tick(1_000); await flush(); }
      assert(outcome() instanceof LaunchClaimUnavailable, `${why}: a retryable 503, got ${String(outcome())}`);
      assert(Date.now() - started <= 20_000, `${why}: answered after ${Date.now() - started} ms`);
      assert.equal(marks, expectedMarks, `${why}: attempts while the budget lasts`);
      assert.deepEqual(store.pendingLaunches().map((row) => row.hash), [sent.hash], `${why}: the hash is still queued for reconcile`);
    } finally { console.error = original; store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("/api/launch/track answers 503 with a one-second Retry-After when the submitted mark cannot be stored, which the client's API layer retries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nft-track-http-"));
  const runtime = runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", DATA_DIR: directory, PLATFORM_TREASURY: treasury });
  const entry = createApp(undefined, "loopback", runtime);
  const server = entry.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  try {
    entry.service.trackLaunch = async () => { throw new LaunchClaimUnavailable(); };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/launch/track`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash: `0x${"3".repeat(64)}`, planId: `0x${"4".repeat(64)}` }) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), { error: "The transaction is queued, but its NFT reservation could not be saved yet. Try again.", code: "LAUNCH_CLAIM_UNAVAILABLE" });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); entry.service.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("reconcile renews a pending creation's submitted claims on each pass, and never once it registered", withStore(async (store) => {
  const sent = coin(3, {}), chain: Chain = { unmined: [] };
  store.savePlan(sent.plan);
  chain.unmined!.push(sent.hash);
  const service = signingService(store, [sent], chain), t0 = Date.now();
  await at(t0, async () => {
    assert.equal(await signingCode(service.validateLaunch(creator, sent.plan.data, true)), "ok");
    await service.trackLaunch(sent.hash, sent.plan.id);
  });
  assert.deepEqual(claimRow(store, museClaim), { owner: sent.plan.id, expiresAt: t0 + 600_000, submitted: 1 });
  await at(t0 + 360_000, () => service.reconcile());
  assert.deepEqual(claimRow(store, museClaim), { owner: sent.plan.id, expiresAt: t0 + 960_000, submitted: 1 }, "renewed from this pass");
  await at(t0 + 700_000, async () => {
    const rival = coin(4, {});
    store.savePlan(rival.plan);
    assert.equal(await signingCode(signingService(store, [rival]).validateLaunch(creator, rival.plan.data, true)), IN_PROGRESS, "held past its first window");
  });
  // Mined: reconcile registers it, which releases the claim; later passes never renew it.
  chain.unmined = [];
  await at(t0 + 720_000, () => service.reconcile());
  assert.equal((await service.token(sent.token))?.nftVerification?.status, "verified");
  assert.equal(claimRow(store, museClaim), undefined);
  // Even when its reorganization check fails at the node (which reaches reconcile's retry path).
  const client = service.client as unknown as { getBlockNumber: () => Promise<bigint> }, head = client.getBlockNumber;
  client.getBlockNumber = async () => { throw new Error("rpc down"); };
  try { await at(t0 + 800_000, () => service.reconcile()); } finally { client.getBlockNumber = head; }
  assert.equal(claimRow(store, museClaim), undefined, "a registered launch is never renewed");
}));

test("reconcile does not renew a creation the node has no trace of, so an evicted or replaced creation lapses within one window", withStore(async (store) => {
  const sent = coin(3, {}), chain: Chain = { untraced: [] };
  store.savePlan(sent.plan);
  const service = signingService(store, [sent], chain), t0 = Date.now();
  await at(t0, async () => {
    assert.equal(await signingCode(service.validateLaunch(creator, sent.plan.data, true)), "ok");
    await service.trackLaunch(sent.hash, sent.plan.id);
  });
  chain.untraced!.push(sent.hash);
  await at(t0 + 360_000, () => service.reconcile());
  assert.equal(claimRow(store, museClaim)?.expiresAt, t0 + 600_000, "not renewed");
  await at(t0 + 600_001, async () => {
    const rival = coin(4, {});
    store.savePlan(rival.plan);
    assert.equal(await signingCode(signingService(store, [rival]).validateLaunch(creator, rival.plan.data, true)), "ok", "the lapsed claim is free");
  });
}));

test("NFT mode's kill switch stops signing too: a plan prepared while on is refused once the flag is off or the guards are missing; normal launches and registration are unaffected", withStore(async (store) => {
  const launch = coin(3, {}), plain = coin(4, { nft: undefined });
  store.savePlan(launch.plan); store.savePlan(plain.plan);
  const unavailable = "NFT_MODE_UNAVAILABLE: NFT mode is not available on this network.";
  const claimed: string[] = [], claim = store.claimLaunch.bind(store);
  store.claimLaunch = (owner, claims, expiresAt, options) => { claimed.push(owner); return claim(owner, claims, expiresAt, options); };
  const protectedPlans = () => (store.db.prepare("SELECT id FROM protected_plans ORDER BY id").all() as { id: string }[]).map((row) => row.id);
  // The flag goes off (a new runtime configuration).
  const off = signingService(store, [launch, plain]);
  Object.assign(off, { runtime: { ...off.runtime, config: { ...off.runtime.config, nftMode: { ...off.runtime.config.nftMode!, enabled: false } } } });
  assert.equal(await signingCode(off.validateLaunch(creator, launch.plan.data, true)), unavailable, "the flag is off");
  assert.equal(await signingCode(off.validateLaunch(creator, launch.plan.data)), "ok", "a preview is not a signature");
  // The database guards are missing (a runtime that has not seen them ready).
  const ready = store.nftGuardsReady.bind(store);
  store.nftGuardsReady = () => false;
  const missing = signingService(store, [launch, plain]);
  assert.equal(await signingCode(missing.validateLaunch(creator, launch.plan.data, true)), unavailable, "the guards are missing");
  assert.deepEqual(claimed, [], "refused before any claim");
  assert.deepEqual(protectedPlans(), [], "and before the plan is protected");
  // Normal launches are unaffected either way.
  assert.equal(await signingCode(off.validateLaunch(creator, plain.plan.data, true)), "ok");
  assert.equal(await signingCode(missing.validateLaunch(creator, plain.plan.data, true)), "ok");
  assert.deepEqual(claimed, []);
  // With NFT mode effective again, the same plan signs.
  store.nftGuardsReady = ready;
  assert.equal(await signingCode(signingService(store, [launch, plain]).validateLaunch(creator, launch.plan.data, true)), "ok");
  assert.equal(claimed.length, 1);
  // Registration of a launch already sent is never gated by the switch.
  assert.equal((await off.register(launch.hash)).nftVerification?.status, "verified");
}));

test("a normal launch never claims or releases anything", withStore(async (store) => {
  const plain = coin(3, { nft: undefined });
  store.savePlan(plain.plan);
  const service = signingService(store, [plain]);
  const touched: string[] = [];
  store.claimLaunch = () => { touched.push("claim"); return []; };
  store.releaseLaunchClaims = () => { touched.push("release"); };
  assert.equal(await signingCode(service.validateLaunch(creator, plain.plan.data, true)), "ok");
  await service.trackLaunch(plain.hash, plain.plan.id);
  assert.equal((await service.register(plain.hash)).nft, undefined);
  assert.deepEqual(touched, []);
}));

test("register never blocks on the Muse pair rule or the flag: a Muse coin paired with WETH registers rejected: pair", withStore(async (store) => {
  const wrong = coin(3, { quoteAddress: weth.address });
  store.savePlan(wrong.plan);
  const record = await registrar(store, [wrong]).service.register(wrong.hash);
  assert.equal(record.nftVerification?.reason, "pair");
}));

test("a recovered backup reads control at its receipt block and records that block", withStore(async (store) => {
  const backup = coin(3, {});
  const { service, reads } = registrar(store, [backup]);
  const record = await service.register(backup.hash, structuredClone(backup.plan));
  assert.deepEqual(record.nftVerification, { status: "verified", block: "10" });
  assert(reads.length > 0 && reads.every((read) => read.endsWith(":10")), `backup reads are at the receipt block: ${reads}`);
}));

// ---- the compare-and-swap store method and the operator CLI ---------------------------------------------------------------------
/** A stored coin; `nft: undefined` leaves the key out, as JSON storage does. */
const nftCoin = (n: number, over: Partial<TokenRecord> = {}): TokenRecord => JSON.parse(JSON.stringify(syntheticToken({ mode: "robinhood",
  address: getAddress(`0x${String(n).repeat(40)}`), transactionHash: `0x${String(n).repeat(64)}`, blockNumber: "10", createdAt: 1_800_000_000_000 + n,
  creator, quoteAddress: musegod.address, nft: muse, ...over })));

// ---- pending fee transactions: only a payment's exact shape is "found but unconfirmed" -----------------------------------------
test("a pending fee transaction counts as unconfirmed only in a payment's shape, under and over the 10-minute window", async () => {
  const key = "q".repeat(32), wei = "5000000000000000", now = Math.floor(Date.now() / 1000), expiresAt = now + 30;
  // A quote signed by `signer` that expires at `at`. The harness's chain head is at most 601 s old, so `now - 1300` is past its mining window.
  const eth = (at = expiresAt, signer = key) => ({ asset: "native" as const, txHash: paidFee, wei, expiresAt: at, mac: launchFeeQuoteMac(signer, 4663, creator, wei, at) });
  const ethTx = { to: treasury, value: BigInt(wei), input: "0x" };
  type Outcome = "retry" | "unverified" | "rejected";
  // [why, claim, the pending transaction, inside the window, after it]
  const cases: [string, LaunchPlan["draft"]["launchFee"], Record<string, unknown>, Outcome, Outcome][] = [
    ["ETH: the signed quote's exact wei, plain, to the treasury", eth(), ethTx, "retry", "unverified"],
    ["ETH: more than the quote, which a mined payment also accepts", eth(), { ...ethTx, value: BigInt(wei) + 1n }, "retry", "unverified"],
    ["ETH: a quote MAC the platform never signed", eth(expiresAt, "x".repeat(32)), ethTx, "rejected", "rejected"],
    ["ETH: a quote whose mining window the chain head has passed", eth(now - 1300), ethTx, "rejected", "rejected"],
    ["ETH: one wei", eth(), { ...ethTx, value: 1n }, "rejected", "rejected"],
    ["ETH: calldata", eth(), { ...ethTx, input: "0xdeadbeef" }, "rejected", "rejected"],
    ["USDG: transfer(treasury, 10 USDG) on USDG", stableClaim, {}, "retry", "unverified"],
    ["USDG: a transfer to someone else", stableClaim, { input: usdgTransfer(getAddress(other)) }, "rejected", "rejected"],
    ["USDG: a transfer of another amount", stableClaim, { input: usdgTransfer(treasury, usdg.amount - 1n) }, "rejected", "rejected"],
    ["USDG: a call to another contract", stableClaim, { to: getAddress(other) }, "retry", "rejected"],
    ["USDG: no transfer call", stableClaim, { input: "0x" }, "retry", "rejected"],
  ];
  for (const [why, claim, feeTx, inside, after] of cases) for (const [age, expected] of [[30n, inside], [601n, after]] as const) {
    const directory = mkdtempSync(join(tmpdir(), "nft-register-pending-")), store = new Store(directory, 31337);
    try {
      const launch = feeLaunch(3, "90", claim);
      store.savePlan(launch.plan);
      const register = () => registrar(store, [launch], { payments: [paidFee], feeFault: "mempool", feeTx, quoteKey: key, receiptAge: age }).service.register(launch.hash);
      const label = `${why}, ${age === 30n ? "inside" : "after"} the window`;
      if (expected === "retry") {
        await assert.rejects(register, /The launch fee check is temporarily unavailable/, label);
        assert.equal(store.tokenByTxHash(launch.hash), null, label);
      } else {
        const record = await register();
        assert.deepEqual(record.nftVerification, expected === "unverified" ? { status: "unverified", reason: "fee_unconfirmed", feeClaim: claim }
          : { status: "rejected", reason: "fee" }, label);
        assert.equal("launchFee" in record, false, `${label}: nothing is spent`);
        assert.equal(isBoundNftCoin(record), expected === "unverified", `${label}: listed only while the real payment may still land`);
      }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

// ---- the database's guards: another process writes after this registration's checks -------------------------------------------
/** Runs `write` (another process: `nft:reverify`, or a second server) once, just before this registration's first token write. */
function writeFirst(store: Store, write: (saveToken: (token: TokenRecord) => void) => void) {
  const saveToken = store.saveToken.bind(store);
  let written = false;
  store.saveToken = (token) => { if (!written) { written = true; write(saveToken); } saveToken(token); };
}

test("a coin the CLI verifies after registration's one-coin check makes the registration rejected: already_launched, never a 500", withStore(async (store) => {
  const launch = coin(3, {}), rival = nftCoin(4, { nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(rival); store.savePlan(launch.plan);
  writeFirst(store, () => store.updateNftVerification({ ...rival, nftVerification: { status: "verified", block: "10" } }));
  const record = await registrar(store, [launch]).service.register(launch.hash);
  assert.deepEqual(record.nftVerification, { status: "rejected", reason: "already_launched" });
  assert.deepEqual(store.token(launch.token)?.nftVerification, { status: "rejected", reason: "already_launched" }, "the coin still registers, rejected");
  assert.equal(store.verifiedNftCoin(nftKey(muse))?.address, rival.address, "the NFT has one verified coin");
}));

test("a fee the CLI spends after registration's single-use check makes the registration rejected: fee, with nothing spent, never a 500", withStore(async (store) => {
  const launch = feeLaunch(3, "80");
  const rival = nftCoin(4, { nft: { ...plainNft, tokenId: "81" }, quoteAddress: weth.address,
    nftVerification: { status: "unverified", reason: "fee_unconfirmed", feeClaim: stableClaim } });
  store.saveToken(rival); store.savePlan(launch.plan);
  writeFirst(store, () => store.updateNftVerification({ ...rival, launchFee: stableClaim, nftVerification: { status: "verified", block: "10" } }));
  const record = await registrar(store, [launch], { payments: [paidFee] }).service.register(launch.hash);
  assert.deepEqual(record.nftVerification, { status: "rejected", reason: "fee" });
  assert.equal("launchFee" in record, false, "the payment is not recorded twice");
  assert.equal(store.token(launch.token)?.nftVerification?.reason, "fee", "the coin still registers, rejected");
  assert.equal(store.tokenUsingLaunchFee(paidFee, creator)?.address, rival.address, "one payment funded one coin");
}));

test("when the CLI takes both the NFT and the fee meanwhile, the registration settles rejected: fee, as if it had seen both", withStore(async (store) => {
  const launch = feeLaunch(3, "82");
  const rival = nftCoin(4, { nft: { ...plainNft, tokenId: "82" }, quoteAddress: weth.address,
    nftVerification: { status: "unverified", reason: "fee_unconfirmed", feeClaim: stableClaim } });
  store.saveToken(rival); store.savePlan(launch.plan);
  writeFirst(store, () => store.updateNftVerification({ ...rival, launchFee: stableClaim, nftVerification: { status: "verified", block: "10" } }));
  const record = await registrar(store, [launch], { payments: [paidFee] }).service.register(launch.hash);
  assert.deepEqual(record.nftVerification, { status: "rejected", reason: "fee" });
  assert.equal("launchFee" in record, false);
  assert.equal(store.verifiedNftCoin(nftKey({ ...plainNft, tokenId: "82" }))?.address, rival.address);
}));

test("a provenance upgrade the database refuses settles rejected: already_launched and still upgrades the record", withStore(async (store) => {
  const launch = coin(3, {}), rival = nftCoin(4, { nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(rival); store.savePlan(launch.plan);
  // Meanwhile another process registered this launch from an unattested backup, and the CLI verified the rival.
  writeFirst(store, (saveToken) => {
    saveToken(nftCoin(3, { openingValuationUnverified: true, nftVerification: { status: "unverified", reason: "rpc" } }));
    store.updateNftVerification({ ...rival, nftVerification: { status: "verified", block: "10" } });
  });
  const record = await registrar(store, [launch]).service.register(launch.hash);
  assert.deepEqual(record.nftVerification, { status: "rejected", reason: "already_launched" });
  assert.equal(record.openingValuationUnverified, undefined, "the saved preview's provenance still replaces the unattested record");
  assert.equal(store.verifiedNftCoin(nftKey(muse))?.address, rival.address);
}));


// Round 4 F2: the upgrade's whole-payload write could revert a verdict and fee that `nft:reverify` wrote after the registration read the row.
test("SQLite: a provenance upgrade never reverts a status the CLI settled meanwhile, nor drops the fee it consumed", withStore(async (store) => {
  const paidNft = { ...plainNft, tokenId: "83" };
  const unproven = nftCoin(3, { nft: paidNft, quoteAddress: weth.address, openingValuationUnverified: true,
    nftVerification: { status: "unverified", reason: "fee_unconfirmed", feeClaim: stableClaim } });
  store.saveToken(unproven);
  // The attested registration read the row (unverified), so its record carries that status and no fee.
  const { openingValuationUnverified: _, ...proven } = unproven;
  // Meanwhile `nft:reverify` confirmed the fee: the coin is verified and spends the payment.
  store.updateNftVerification({ ...unproven, launchFee: stableClaim, nftVerification: { status: "verified", block: "10" } });
  store.upgradeTokenProvenance(proven);
  const stored = store.token(unproven.address)!;
  assert.equal(stored.openingValuationUnverified, undefined, "provenance still improves");
  assert.deepEqual(stored.nftVerification, { status: "verified", block: "10" }, "the settled status stands");
  assert.deepEqual(stored.launchFee, stableClaim, "the consumed fee stands");
  assert.equal(store.tokenUsingLaunchFee(paidFee, creator)?.address, unproven.address, "the payment stays spent");
  assert.equal(store.verifiedNftCoin(nftKey(paidNft))?.address, unproven.address, "the NFT keeps its verified coin");
  // A rejected status is settled too: an upgrade built from an unverified read never reopens it.
  const rejected = nftCoin(4, { nft: { ...paidNft, tokenId: "84" }, openingValuationUnverified: true, nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(rejected);
  store.updateNftVerification({ ...rejected, nftVerification: { status: "rejected", reason: "not_controller" } });
  const { openingValuationUnverified: __, ...rejectedProven } = rejected;
  store.upgradeTokenProvenance(rejectedProven);
  assert.deepEqual(store.token(rejected.address)?.nftVerification, { status: "rejected", reason: "not_controller" });
  assert.equal(store.token(rejected.address)?.openingValuationUnverified, undefined);
  // An open status without a consumed fee is still settled by the upgrade's own decision, as before.
  const open = nftCoin(5, { nft: { ...paidNft, tokenId: "85" }, openingValuationUnverified: true, nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(open);
  const { openingValuationUnverified: ___, ...openProven } = open;
  store.upgradeTokenProvenance({ ...openProven, nftVerification: { status: "rejected", reason: "already_launched" } });
  assert.deepEqual(store.token(open.address)?.nftVerification, { status: "rejected", reason: "already_launched" });
}));

test("Supabase: a provenance upgrade is a compare-and-swap on the NFT fields it read, re-read and retried a bounded number of times", async () => {
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-nft");
  const unproven = nftCoin(3, { nft: { ...plainNft, tokenId: "86" }, quoteAddress: weth.address, openingValuationUnverified: true,
    nftVerification: { status: "unverified", reason: "fee_unconfirmed", feeClaim: stableClaim } });
  const settled = { ...unproven, launchFee: stableClaim, nftVerification: { status: "verified" as const, block: "10" } };
  const { openingValuationUnverified: _, ...proven } = unproven;
  const calls: { path: string; method: string; body: unknown; prefer?: string }[] = [];
  // The CLI settles the row between the upgrade's first read and its first write.
  const reads = [unproven, settled];
  let patches = 0;
  store.request = async <T>(path: string, method = "GET", body?: unknown, prefer?: string) => {
    calls.push({ path: decodeURIComponent(path), method, body, prefer });
    if (method === "GET") return [{ payload: reads[Math.min(patches, reads.length - 1)] }] as T;
    patches++;
    return (patches === 1 ? [] : [{ address: unproven.address.toLowerCase() }]) as T;
  };
  await store.upgradeTokenProvenance(proven);
  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 2, "the write that matched nothing is retried after a fresh read");
  assert.equal(calls.filter((call) => call.method === "GET").length, 2);
  const row = ["musegod_tokens?scope=eq.verify-nft", `address=eq.${unproven.address.toLowerCase()}`, `tx_hash=eq.${unproven.transactionHash!.toLowerCase()}`,
    "payload->>openingValuationUnverified=eq.true"];
  for (const part of [...row, "payload->nftVerification->>status=eq.unverified", "payload->launchFee=is.null", `payload->nftVerification->feeClaim->>txHash=eq.${paidFee}`])
    assert(writes[0].path.includes(part), `first write: missing ${part} in ${writes[0].path}`);
  for (const part of [...row, "payload->nftVerification->>status=eq.verified", `payload->launchFee->>txHash=eq.${paidFee}`, "payload->nftVerification->feeClaim=is.null"])
    assert(writes[1].path.includes(part), `second write: missing ${part} in ${writes[1].path}`);
  assert(writes.every((call) => call.prefer === "return=representation" && call.path.includes("select=address")), "each write reports the rows it changed");
  const written = (writes[1].body as { payload: TokenRecord }).payload;
  assert.equal(written.openingValuationUnverified, undefined);
  assert.deepEqual([written.nftVerification, written.launchFee], [settled.nftVerification, stableClaim], "the settled status and the consumed fee are kept");
  // A row that keeps changing fails the registration retryably instead of writing over it.
  calls.length = 0; patches = 0;
  store.request = async <T>(path: string, method = "GET", body?: unknown, prefer?: string) => {
    calls.push({ path: decodeURIComponent(path), method, body, prefer });
    return (method === "GET" ? [{ payload: unproven }] : []) as T;
  };
  await assert.rejects(store.upgradeTokenProvenance(proven), /changed while its provenance was upgraded/);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 3, "bounded");
  // Nothing to upgrade: no write at all.
  calls.length = 0;
  store.request = async <T>(path: string, method = "GET", body?: unknown, prefer?: string) => { calls.push({ path: decodeURIComponent(path), method, body, prefer }); return [] as T; };
  await store.upgradeTokenProvenance(proven);
  await store.upgradeTokenProvenance(unproven);
  assert.deepEqual(calls.map((call) => call.method), ["GET"], "an already proven row is never written; an unproven record never upgrades");
});

test("updateNftVerification settles only an unverified or absent status, and never a record without nft", withStore(async (store) => {
  const open = nftCoin(3, { nftVerification: { status: "unverified", reason: "rpc" } }), bare = nftCoin(4), plain = nftCoin(5, { nft: undefined });
  const final = nftCoin(6, { nftVerification: { status: "rejected", reason: "not_controller" } });
  for (const record of [open, bare, plain, final]) store.saveToken(record);
  store.updateNftVerification({ ...open, nftVerification: { status: "verified", block: "10" } });
  assert.deepEqual(store.token(open.address)?.nftVerification, { status: "verified", block: "10" });
  store.updateNftVerification({ ...open, nftVerification: { status: "rejected", reason: "already_launched" } });
  assert.equal(store.token(open.address)?.nftVerification?.status, "verified", "a verified status is final");
  store.updateNftVerification({ ...bare, nftVerification: { status: "rejected", reason: "already_launched" } });
  assert.equal(store.token(bare.address)?.nftVerification?.reason, "already_launched", "no status counts as unverified");
  store.updateNftVerification({ ...final, nftVerification: { status: "verified" } });
  assert.equal(store.token(final.address)?.nftVerification?.status, "rejected", "a rejected status is final");
  store.updateNftVerification({ ...plain, nft: muse, nftVerification: { status: "verified" } });
  assert.deepEqual(store.token(plain.address), plain, "a record without nft is never touched");
  store.updateNftVerification({ ...nftCoin(3, { transactionHash: `0x${"9".repeat(64)}` }), nftVerification: { status: "rejected", reason: "x" } });
  assert.equal(store.token(open.address)?.nftVerification?.status, "verified", "another launch's hash never matches");
}));

test("the Supabase store issues the same compare-and-swap as two explicit filters (not.in skips NULLs)", async () => {
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-nft");
  const calls: { path: string; method: string; body: unknown }[] = [];
  store.request = async <T>(path: string, method = "GET", body?: unknown) => { calls.push({ path: decodeURIComponent(path), method, body }); return undefined as T; };
  const record = nftCoin(3, { transactionHash: `0x${"AB".repeat(32)}`, nftVerification: { status: "verified", block: "10" } });
  await store.updateNftVerification(record);
  assert.equal(calls.length, 2);
  const common = ["musegod_tokens?scope=eq.verify-nft", `address=eq.${record.address.toLowerCase()}`, `tx_hash=eq.0x${"ab".repeat(32)}`, "payload->nft=not.is.null",
    "payload->>openingValuationUnverified=is.null"];
  for (const [index, filter] of ["payload->nftVerification->>status=eq.unverified", "payload->nftVerification=is.null"].entries()) {
    for (const part of [...common, filter]) assert(calls[index].path.includes(part), `missing ${part} in ${calls[index].path}`);
    assert.equal(calls[index].method, "PATCH"); assert.deepEqual(calls[index].body, { payload: record });
  }
  calls.length = 0;
  await store.updateNftVerification({ ...record, openingValuationUnverified: true });
  assert(calls.every((call) => call.path.includes("payload->>openingValuationUnverified=eq.true")), "an unproven read matches only an unproven row");
  calls.length = 0;
  await store.updateNftVerification(nftCoin(3, { nft: undefined, nftVerification: { status: "verified" } }));
  await store.updateNftVerification(nftCoin(3));
  assert.equal(calls.length, 0, "nothing is sent without nft or a status");
});

/** `race`: another coin for the NFT is saved verified right after the CLI's one-coin check; `feeRace`: another coin is saved holding the fee
 * right after the CLI's fee check passes (the server registering it meanwhile, in both cases). */
type CliChain = { holder?: Address | "fail"; fee?: "ok" | "invalid" | "rpc" | "missing" | "unconfirmed"; race?: TokenRecord; feeRace?: TokenRecord; guards?: boolean };
function cli(store: Store, chain: CliChain = {}) {
  const reads: string[] = [], feeChecks: string[] = [];
  let raced = false;
  const deps: NftReverifyDeps = { chainId: 4663,
    store: { token: (address) => store.token(address), updateNftVerification: (token) => store.updateNftVerification(token),
      tokenUsingLaunchFee: (txHash, payer, exclude) => store.tokenUsingLaunchFee(txHash, payer, exclude),
      nftGuardsReady: () => chain.guards ?? store.nftGuardsReady(),
      // `race`: another coin for the NFT is saved verified right after the CLI's one-coin check (the server registering it meanwhile).
      verifiedNftCoin: (key, exclude) => {
        const found = store.verifiedNftCoin(key, exclude);
        if (chain.race && !raced) { raced = true; store.saveToken(chain.race); }
        return found;
      } },
    client: { readContract: (async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      reads.push(`${functionName}:${blockNumber ?? "latest"}`);
      if (chain.holder === "fail") throw new Error("rpc down");
      return functionName === "supportsInterface" ? true : functionName === "ownerOf" ? chain.holder ?? creator : false;
    }) as never },
    assertUnusedLaunchFee: async (fee) => {
      feeChecks.push(fee.txHash);
      if (chain.fee === "rpc") throw new Error("rpc down");
      if (chain.fee === "missing") throw new NftLaunchError("NFT_FEE_INVALID", "not mined", "missing");
      if (chain.fee === "unconfirmed") throw new NftLaunchError("NFT_FEE_INVALID", "confirming", "unconfirmed");
      if (chain.fee !== "ok") throw new NftLaunchError("NFT_FEE_INVALID", "not paid");
      if (chain.feeRace) store.saveToken(chain.feeRace);
    } };
  return { deps, reads, feeChecks };
}
const done = (...lines: string[]) => ({ lines, failed: false });

test("nft:reverify settles unverified coins at their receipt block with the one-coin rule, and leaves everything else alone", withStore(async (store) => {
  const open = nftCoin(3, { nftVerification: { status: "unverified", reason: "rpc" } }), plain = nftCoin(4, { nft: undefined });
  const verified = nftCoin(5, { nft: { ...muse, tokenId: "2" }, nftVerification: { status: "verified" } });
  const late = nftCoin(6, { nft: { ...muse, tokenId: "2" } });
  for (const record of [open, plain, verified, late]) store.saveToken(record);
  const { deps, reads } = cli(store);
  assert.deepEqual(await nftReverifyCommand(["4663", open.address, plain.address, verified.address, late.address], deps), done(
    `${open.address}: unverified -> verified`, `${plain.address}: not an NFT coin, untouched`, `${verified.address}: verified, final`,
    `${late.address}: none -> rejected (already_launched)`));
  assert.deepEqual(store.token(open.address)?.nftVerification, { status: "verified", block: "10" });
  assert.deepEqual(store.token(plain.address), plain);
  assert(reads.length > 0 && reads.every((read) => read.endsWith(":10")), `reads are at the receipt block: ${reads}`);
}));

test("nft:reverify keeps an unverified coin's fee as registration verified it, without re-checking it", withStore(async (store) => {
  // A treasury or quote-key rotation since registration must not un-consume a payment that verified then.
  const fee = { asset: "stable" as const, txHash: `0x${"ef".repeat(32)}` as Hex };
  const paid = nftCoin(5, { nft: plainNft, quoteAddress: weth.address, launchFee: fee, nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(paid);
  const { deps, feeChecks } = cli(store, { fee: "invalid" });
  assert.deepEqual(await nftReverifyCommand(["4663", paid.address], deps), done(`${paid.address}: unverified -> verified`));
  assert.deepEqual(store.token(paid.address)?.launchFee, fee);
  assert.deepEqual(feeChecks, [], "the fee is not checked again");
}));

test("nft:reverify never touches a rejected coin, whatever the chain now says", withStore(async (store) => {
  const refused = nftCoin(5, { nft: plainNft, quoteAddress: weth.address, nftVerification: { status: "rejected", reason: "fee" },
    launchFee: { asset: "stable", txHash: `0x${"ab".repeat(32)}` } });
  store.saveToken(refused);
  const { deps, reads, feeChecks } = cli(store, { fee: "ok" });
  assert.deepEqual(await nftReverifyCommand(["4663", refused.address], deps), done(`${refused.address}: rejected, final`));
  assert.deepEqual(store.token(refused.address), refused);
  assert.deepEqual([reads, feeChecks], [[], []]);
}));

test("nft:reverify re-checks a fee_unconfirmed coin's claimed fee and settles it once the chain answers definitively", withStore(async (store) => {
  const claimOf = (n: number) => ({ asset: "stable" as const, txHash: `0x${String(n).repeat(64)}` as Hex });
  // An hour old: past the settlement window.
  const open = (n: number) => nftCoin(n, { nft: { ...plainNft, tokenId: String(60 + n) }, quoteAddress: weth.address, createdAt: Date.now() - 3_600_000,
    nftVerification: { status: "unverified", reason: "fee_unconfirmed", feeClaim: claimOf(n) } });
  const paid = open(3), invalid = open(4), missing = open(5), offline = open(6), confirming = open(7);
  for (const record of [paid, invalid, missing, offline, confirming]) store.saveToken(record);
  const ok = cli(store, { fee: "ok" });
  assert.deepEqual(await nftReverifyCommand(["4663", paid.address], ok.deps), done(`${paid.address}: unverified -> verified`));
  assert.deepEqual(store.token(paid.address)?.nftVerification, { status: "verified", block: "10" }, "the claim is gone from the status");
  assert.deepEqual(store.token(paid.address)?.launchFee, claimOf(3), "the verified claim is now the coin's spent fee");
  assert.deepEqual(ok.feeChecks, [claimOf(3).txHash]);
  assert(ok.reads.length > 0 && ok.reads.every((read) => read.endsWith(":10")));
  for (const [record, fee] of [[invalid, "invalid"], [missing, "missing"]] as const) {
    assert.deepEqual(await nftReverifyCommand(["4663", record.address], cli(store, { fee }).deps), done(`${record.address}: unverified -> rejected (fee)`), fee);
    assert.equal(store.token(record.address)?.launchFee, undefined, `${fee}: nothing is spent`);
  }
  for (const [record, fee] of [[offline, "rpc"], [confirming, "unconfirmed"]] as const) {
    assert.deepEqual(await nftReverifyCommand(["4663", record.address], cli(store, { fee }).deps),
      done(`${record.address}: unverified, unchanged (launch-fee check unavailable)`), fee);
    assert.deepEqual(store.token(record.address), record, `${fee}: still unverified, with its claim`);
  }
}));

test("nft:reverify leaves an unverified coin whose fee could not be confirmed unchanged: it never consumed a payment", withStore(async (store) => {
  const open = nftCoin(5, { nft: plainNft, quoteAddress: weth.address, nftVerification: { status: "unverified", reason: "fee_unconfirmed" } });
  store.saveToken(open);
  const { deps, reads, feeChecks } = cli(store, { fee: "ok" });
  assert.deepEqual(await nftReverifyCommand(["4663", open.address], deps),
    done(`${open.address}: unverified, unchanged (no launch fee was verified; its payment stays unspent)`));
  assert.deepEqual(store.token(open.address), open, "never rejected: fee for a payment that could not be read");
  assert.deepEqual([reads, feeChecks], [[], []]);
}));

test("nft:reverify re-checks the fee only on a record with no status, and drops one that does not verify", withStore(async (store) => {
  const claim = (n: number, tokenId: string) => nftCoin(n, { nft: { ...plainNft, tokenId }, quoteAddress: weth.address,
    launchFee: { asset: "stable", txHash: `0x${String(n).repeat(64)}` } });
  const unavailable = claim(3, "3"), unpaid = claim(4, "4"), paid = claim(5, "5");
  for (const record of [unavailable, unpaid, paid]) store.saveToken(record);
  assert.deepEqual(await nftReverifyCommand(["4663", unavailable.address], cli(store, { fee: "rpc" }).deps), done(`${unavailable.address}: none, unchanged (launch-fee check unavailable)`));
  assert.deepEqual(store.token(unavailable.address), unavailable);
  assert.deepEqual(await nftReverifyCommand(["4663", unpaid.address], cli(store, { fee: "invalid" }).deps), done(`${unpaid.address}: none -> rejected (fee)`));
  assert.equal(store.token(unpaid.address)?.launchFee, undefined, "a fee that does not verify is dropped from the record");
  const ok = cli(store, { fee: "ok" });
  assert.deepEqual(await nftReverifyCommand(["4663", paid.address], ok.deps), done(`${paid.address}: none -> verified`));
  assert.deepEqual(store.token(paid.address)?.launchFee, paid.launchFee); assert.deepEqual(ok.feeChecks, [paid.launchFee!.txHash]);
}));

test("nft:reverify strips a launch fee from a Muse coin, which launches free", withStore(async (store) => {
  const muse3 = nftCoin(3, { launchFee: { asset: "stable", txHash: `0x${"cd".repeat(32)}` } });
  store.saveToken(muse3);
  const { deps, feeChecks } = cli(store, { fee: "ok" });
  assert.deepEqual(await nftReverifyCommand(["4663", muse3.address], deps), done(`${muse3.address}: none -> verified`));
  assert.equal("launchFee" in store.token(muse3.address)!, false);
  assert.deepEqual(feeChecks, []);
}));

test("nft:reverify leaves a record unchanged while the RPC still fails, and refuses bad arguments", withStore(async (store) => {
  const open = nftCoin(3, { nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(open);
  assert.deepEqual(await nftReverifyCommand(["4663", open.address], cli(store, { holder: "fail" }).deps), done(`${open.address}: unverified, unchanged (RPC unavailable)`));
  assert.deepEqual(store.token(open.address), open);
  await assert.rejects(() => nftReverifyCommand(["1", open.address], cli(store).deps), /Usage/);
  await assert.rejects(() => nftReverifyCommand(["4663"], cli(store).deps), /Usage/);
  await assert.rejects(() => nftReverifyCommand(["4663", "not-an-address"], cli(store).deps), /Usage/);
}));

const conflictOf = (kind: TokenUniqueConflict["kind"]) => (error: unknown) => error instanceof TokenUniqueConflict && error.kind === kind;

test("SQLite: the database refuses the CLI's second verified coin for an NFT, and the CLI reports CONFLICT and fails", withStore(async (store) => {
  const open = nftCoin(3, { nftVerification: { status: "unverified", reason: "rpc" } });
  const rival = nftCoin(4, { nftVerification: { status: "verified" }, createdAt: 1_800_000_000_100 });
  store.saveToken(open);
  const result = await nftReverifyCommand(["4663", open.address], cli(store, { race: rival }).deps);
  assert.deepEqual(result, { lines: [`CONFLICT ${nftKey(muse)} ${open.address} ${rival.address}`], failed: true });
  assert.deepEqual(store.token(open.address), open, "the refused write changed nothing");
  // The store method itself: a verified write is refused while another coin holds the NFT; other outcomes still apply.
  assert.throws(() => store.updateNftVerification({ ...open, nftVerification: { status: "verified" } }), conflictOf("nft_verified"));
  assert.equal(store.token(open.address)?.nftVerification?.status, "unverified");
  store.updateNftVerification({ ...open, nftVerification: { status: "rejected", reason: "already_launched" } });
  assert.equal(store.token(open.address)?.nftVerification?.reason, "already_launched");
  const elsewhere = nftCoin(5, { nft: { ...muse, tokenId: "2" }, nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(elsewhere);
  store.updateNftVerification({ ...elsewhere, nftVerification: { status: "verified" } });
  assert.equal(store.token(elsewhere.address)?.nftVerification?.status, "verified", "another NFT's coin is no conflict");
}));

test("SQLite: a fee the server spends while the CLI settles a fee_unconfirmed coin is refused to the CLI: CONFLICT and a failure", withStore(async (store) => {
  const claim = { asset: "stable" as const, txHash: `0x${"ab".repeat(32)}` as Hex };
  const open = nftCoin(3, { nft: { ...plainNft, tokenId: "3" }, quoteAddress: weth.address, createdAt: Date.now() - 3_600_000,
    nftVerification: { status: "unverified", reason: "fee_unconfirmed", feeClaim: claim } });
  const winner = nftCoin(4, { nft: { ...plainNft, tokenId: "4" }, quoteAddress: weth.address, launchFee: claim, nftVerification: { status: "verified" } });
  store.saveToken(open);
  const run = cli(store, { fee: "ok", feeRace: winner });
  assert.deepEqual(await nftReverifyCommand(["4663", open.address], run.deps), { lines: [`CONFLICT ${claim.txHash} ${open.address} ${winner.address}`], failed: true });
  assert.deepEqual(run.feeChecks, [claim.txHash], "the fee was unused when checked");
  assert.deepEqual(store.token(open.address), open, "the refused write changed nothing: the claim is still only a claim");
  assert.equal(store.tokenUsingLaunchFee(claim.txHash, creator)?.address, winner.address, "one payment funded one coin");
  assert.throws(() => store.updateNftVerification({ ...open, launchFee: claim, nftVerification: { status: "rejected", reason: "already_launched" } }),
    conflictOf("launch_fee"), "the guard holds for any status that spends the fee");
}));

test("nft:reverify applies the pending-payment rules to a fee_unconfirmed coin's claim: only a payment's shape stays open", withStore(async (store) => {
  const key = "q".repeat(32), wei = "5000000000000000", now = Math.floor(Date.now() / 1000), expiresAt = now + 30;
  const eth = (at = expiresAt, signer = key) => ({ asset: "native" as const, txHash: paidFee, wei, expiresAt: at, mac: launchFeeQuoteMac(signer, 4663, creator, wei, at) });
  const ethTx = { to: treasury, value: BigInt(wei), input: "0x" };
  const cases: [string, NonNullable<TokenRecord["launchFee"]>, Record<string, unknown>, string][] = [
    ["USDG: transfer(treasury, 10 USDG) on USDG", stableClaim, {}, "unverified, unchanged (launch-fee check unavailable)"],
    ["USDG: a call to another contract", stableClaim, { to: getAddress(other) }, "unverified -> rejected (fee)"],
    ["USDG: a transfer to someone else", stableClaim, { input: usdgTransfer(getAddress(other)) }, "unverified -> rejected (fee)"],
    ["ETH: the signed quote's exact wei", eth(), ethTx, "unverified, unchanged (launch-fee check unavailable)"],
    ["ETH: more than the quote", eth(), { ...ethTx, value: BigInt(wei) + 1n }, "unverified, unchanged (launch-fee check unavailable)"],
    ["ETH: a quote MAC the platform never signed", eth(expiresAt, "x".repeat(32)), ethTx, "unverified -> rejected (fee)"],
    ["ETH: a quote whose mining window the chain head has passed", eth(now - 1300), ethTx, "unverified -> rejected (fee)"],
  ];
  for (const [index, [why, claim, feeTx, outcome]] of cases.entries()) {
    // An hour old: past the settlement window.
    const record = nftCoin(index + 3, { nft: { ...plainNft, tokenId: String(100 + index) }, quoteAddress: weth.address, createdAt: Date.now() - 3_600_000,
      nftVerification: { status: "unverified", reason: "fee_unconfirmed", feeClaim: claim } });
    store.saveToken(record);
    const { service } = registrar(store, [], { payments: [paidFee], feeFault: "mempool", feeTx, quoteKey: key });
    const deps: NftReverifyDeps = { ...cli(store).deps, assertUnusedLaunchFee: (fee, payer, self) => service.assertUnusedLaunchFee(fee, payer, self) };
    assert.deepEqual(await nftReverifyCommand(["4663", record.address], deps), done(`${record.address}: ${outcome}`), why);
    if (outcome.includes("unchanged")) assert.deepEqual(store.token(record.address), record, `${why}: the claim stays open`);
    else assert.equal(store.token(record.address)?.launchFee, undefined, `${why}: nothing is spent`);
  }
}));

test("nft:reverify refuses to run without the database's single-use guards, changing and reading nothing", withStore(async (store) => {
  const open = nftCoin(3, { nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(open);
  const run = cli(store, { guards: false });
  await assert.rejects(nftReverifyCommand(["4663", open.address], run.deps),
    /^Error: The NFT single-use database guards are missing: apply supabase\/migrations\/20261014120000_nft_single_use_indexes\.sql, then run nft:reverify again\. Nothing was changed\.$/);
  assert.deepEqual([run.reads, run.feeChecks], [[], []]);
  assert.deepEqual(store.token(open.address), open);
  await assert.rejects(nftReverifyCommand(["4663"], run.deps), /Usage/, "bad arguments are still refused first");
  // Supabase without the migration: the function is missing (404), so the command refuses before any token read.
  const supabase = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-nft");
  const original = globalThis.fetch, paths: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    paths.push(String(url));
    return Response.json({ code: "PGRST202", message: "Could not find the function public.musegod_nft_guards_ready" }, { status: 404 });
  }) as typeof fetch;
  try {
    await assert.rejects(nftReverifyCommand(["4663", open.address], { ...run.deps, store: supabase }), /guards are missing/);
    assert.deepEqual(paths, ["https://fixture.supabase.co/rest/v1/rpc/musegod_nft_guards_ready"]);
  } finally { globalThis.fetch = original; }
}));

test("registration is never gated on the guards: a launched coin registers even while the database lacks them", withStore(async (store) => {
  const launch = coin(3, {});
  store.savePlan(launch.plan);
  let asked = 0;
  store.nftGuardsReady = () => { asked++; return false; };
  assert.deepEqual((await registrar(store, [launch]).service.register(launch.hash)).nftVerification, { status: "verified" });
  assert.equal(asked, 0);
}));

test("the compare-and-swap never downgrades provenance: it matches the opening-valuation state that was read", withStore(async (store) => {
  const stale = nftCoin(3, { openingValuationUnverified: true, nftVerification: { status: "unverified", reason: "rpc" } });
  const { openingValuationUnverified: _, ...upgraded } = stale;
  store.saveToken(upgraded);
  store.updateNftVerification({ ...stale, nftVerification: { status: "verified" } });
  assert.deepEqual(store.token(stale.address), upgraded, "a write based on the unproven read cannot replace the proven record");
  store.updateNftVerification({ ...upgraded, nftVerification: { status: "verified" } });
  assert.equal(store.token(stale.address)?.nftVerification?.status, "verified");
  const unproven = nftCoin(4, { nft: { ...muse, tokenId: "5" }, openingValuationUnverified: true, nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(unproven);
  store.updateNftVerification({ ...unproven, nftVerification: { status: "verified" } });
  assert.deepEqual(store.token(unproven.address), { ...unproven, nftVerification: { status: "verified" } }, "a matching unproven read still settles");
}));

test("Supabase: the database refuses the CLI's second verified coin (409, 23505), so the CLI reports CONFLICT; a write is never followed by a re-read guard", async () => {
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-nft");
  const open = nftCoin(3, { nftVerification: { status: "unverified", reason: "rpc" } }), rival = nftCoin(4, { nftVerification: { status: "verified" } });
  const original = globalThis.fetch, calls: string[] = [];
  let refuse = true, stored: TokenRecord = open;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url)).replace("https://fixture.supabase.co/rest/v1/", ""), method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method === "PATCH") {
      if (refuse) return new Response(JSON.stringify({ code: "23505", details: null, hint: null,
        message: "duplicate key value violates unique constraint \"musegod_tokens_nft_verified_once\"" }), { status: 409 });
      if (path.includes("status=eq.unverified") && stored.nftVerification?.status === "unverified") stored = JSON.parse(String(init?.body)).payload;
      return new Response(null, { status: 204 });
    }
    if (path === "rpc/musegod_nft_guards_ready") return Response.json(true);
    // The rival is verified only once the CLI has tried to write (the server registering it meanwhile).
    if (path.includes("payload->nftVerification->>status=eq.verified")) return Response.json(refuse && calls.some((call) => call.startsWith("PATCH")) ? [{ payload: rival }] : []);
    return Response.json([{ payload: stored }]);
  }) as typeof fetch;
  try {
    const deps: NftReverifyDeps = { ...cli(undefined as never).deps, store };
    assert.deepEqual(await nftReverifyCommand(["4663", open.address], deps), { lines: [`CONFLICT ${nftKey(muse)} ${open.address} ${rival.address}`], failed: true });
    const patches = calls.filter((call) => call.startsWith("PATCH"));
    assert.equal(patches.length, 1, "the refused write stops at once");
    assert(patches[0].includes("payload->>openingValuationUnverified=is.null"), `provenance is matched: ${patches[0]}`);
    assert.deepEqual(stored, open, "nothing was written");
    // A verified write the database accepts is final: no one-coin re-read follows it.
    refuse = false; calls.length = 0;
    assert.deepEqual(await nftReverifyCommand(["4663", open.address], deps), done(`${open.address}: unverified -> verified`));
    const firstPatch = calls.findIndex((call) => call.startsWith("PATCH"));
    assert(firstPatch > 0, "the one-coin check runs before the write");
    assert.deepEqual(calls.slice(firstPatch).filter((call) => call.includes("payload->nftVerification->>status=eq.verified")), [], "no re-read after the write");
  } finally { globalThis.fetch = original; }
});
