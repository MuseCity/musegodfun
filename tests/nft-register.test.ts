import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DopplerSDK, airlockAbi, computePoolId, rehypeDopplerHookInitializerAbi } from "@whetstone-research/doppler-sdk/evm";
import { ContractFunctionExecutionError, HttpRequestError, isHex, TimeoutError, TransactionReceiptNotFoundError, createPublicClient, decodeFunctionData,
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, http, keccak256, multicall3Abi, zeroAddress,
  type Address, type Hex } from "viem";
import { base as baseChain } from "viem/chains";
import { ROBINHOOD_CONTRACTS as contracts, ROBINHOOD_STOCKS, SUPPLY, type TokenRecord } from "../src/lib/config";
import { MUSES, NFT_VAULT_MANIFEST, nftKey } from "../src/lib/nft-mode";
import { LAUNCH_FEE_MIN_BLOCK, LAUNCH_FEE_STABLE } from "../src/lib/launch-fee";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { FEE_POLICY } from "../src/lib/fee-policy";
import { buildLaunch } from "../src/lib/protocol";
import { serializePrepared, type LaunchPlan } from "../src/lib/launch-plan";
import { NftLaunchError, isContractAnswer, nftRegistrationStatus, readNftControl } from "../server/nft-launch";
import { ENGINE_MANIFEST } from "../server/launch-policy-registry";
import { LaunchpadService } from "../server/service";
import { Store } from "../server/store";
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
      store: { verifiedNftCoin: async () => null },
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
function coin(n: number, draftOver: Record<string, unknown>) {
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
/** An exact 10 USDG payment from the creator to the treasury. */
const feePayment = (hash: Hex) => ({ status: "success", transactionHash: hash, blockNumber: FEE_BLOCK, blockHash, from: creator, logs: [{ address: usdg.address,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: creator, to: treasury } }), data: encodeAbiParameters([{ type: "uint256" }], [usdg.amount]) }] });

/** `feeFault`: the fee payment is mined but has one confirmation, sits in a reorganized block, or its receipt read fails at the node.
 * `feeReceipt`: fields that replace those of the exact payment (a definite mismatch). */
type Chain = { holder?: Address | "fail"; receiptAge?: bigint; delayMs?: number; payments?: Hex[]; feeFault?: "unconfirmed" | "reorganized" | "rpc";
  feeReceipt?: Record<string, unknown> };
/** The service with the registration harness's stubs. Every NFT read is logged with the block it asked for ("latest" when none). */
function registrar(store: Store, coins: Coin[], chain: Chain = {}) {
  const reads: string[] = [], now = BigInt(Math.floor(Date.now() / 1000));
  const byHash = (hash: Hex) => coins.find((c) => c.hash.toLowerCase() === hash.toLowerCase());
  const service = Object.assign(Object.create(LaunchpadService.prototype), { launchManifest: () => ({ ...ENGINE_MANIFEST, engineLaunchCutover: undefined }) }, {
    runtime: { config: { mode: "fork", chainId: 31337, deploymentChainId: 4663, writesEnabled: false, treasury }, secrets: {} },
    store, assertNetwork: async () => {},
    client: {
      getTransaction: async ({ hash }: { hash: Hex }) => byHash(hash)!.tx,
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const found = byHash(hash);
        if (found) return found.receipt;
        if (chain.payments?.some((paid) => paid.toLowerCase() === hash.toLowerCase())) {
          if (chain.feeFault === "rpc") throw new HttpRequestError({ url: "https://rpc.fixture.test", status: 503 });
          return { ...feePayment(hash), ...(chain.feeFault === "reorganized" ? { blockHash: `0x${"cc".repeat(32)}` } : {}), ...chain.feeReceipt };
        }
        throw new TransactionReceiptNotFoundError({ hash });
      },
      getBlockNumber: async () => chain.feeFault === "unconfirmed" ? FEE_BLOCK : FEE_BLOCK + 100n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        const valuation = coins[0].plan.openingValuation!;
        return { hash: blockNumber === BigInt(valuation.blockNumber) ? valuation.blockHash : blockHash, timestamp: now - (chain.receiptAge ?? 30n) };
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

test("a fee still confirming, reorganized or unreadable fails registration retryably for 10 minutes, then records unverified and stays unconsumed", withStore(async (store) => {
  const paid = `0x${"cd".repeat(32)}` as Hex, fee = { asset: "stable" as const, txHash: paid };
  const cases: [string, Chain][] = [["not mined yet", { payments: [] }], ["one confirmation", { payments: [paid], feeFault: "unconfirmed" }],
    ["reorganized block", { payments: [paid], feeFault: "reorganized" }], ["node failure", { payments: [paid], feeFault: "rpc" }]];
  for (const [index, [why, chain]] of cases.entries()) {
    const launch = coin(3 + index, { nft: { ...plainNft, tokenId: String(10 + index) }, quoteAddress: weth.address, launchFee: fee });
    store.savePlan(launch.plan);
    await assert.rejects(() => registrar(store, [launch], { ...chain, receiptAge: 30n }).service.register(launch.hash),
      /The launch fee check is temporarily unavailable\. Registration will retry\./, why);
    assert.equal(store.tokenByTxHash(launch.hash), null, `${why}: nothing is written while a retry is still useful`);
    const late = await registrar(store, [launch], { ...chain, receiptAge: 601n }).service.register(launch.hash);
    assert.deepEqual(late.nftVerification, { status: "unverified", reason: "fee_unconfirmed" }, why);
    assert.equal("launchFee" in late, false, `${why}: an unconfirmed fee is never recorded as spent`);
    assert.equal(store.tokenUsingLaunchFee(paid, creator), null, `${why}: the payment stays unconsumed`);
  }
}));

test("a definite fee mismatch is rejected: fee at once, even for a coin under 10 minutes old", withStore(async (store) => {
  const paid = `0x${"cd".repeat(32)}` as Hex, fee = { asset: "stable" as const, txHash: paid };
  const transfer = (to: Address, amount: bigint) => ({ address: usdg.address, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: creator, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]) });
  const cases: [string, Chain["feeReceipt"]][] = [["wrong amount", { logs: [transfer(treasury, usdg.amount + 1n)] }], ["wrong recipient", { logs: [transfer(getAddress(other), usdg.amount)] }],
    ["wrong payer", { from: other }], ["wrong asset", { logs: [{ ...transfer(treasury, usdg.amount), address: weth.address }] }], ["reverted", { status: "reverted" }]];
  for (const [index, [why, feeReceipt]] of cases.entries()) {
    const launch = coin(3 + index, { nft: { ...plainNft, tokenId: String(20 + index) }, quoteAddress: weth.address, launchFee: fee });
    store.savePlan(launch.plan);
    const record = await registrar(store, [launch], { payments: [paid], feeReceipt, receiptAge: 30n }).service.register(launch.hash);
    assert.deepEqual(record.nftVerification, { status: "rejected", reason: "fee" }, why);
    assert.equal(record.launchFee, undefined, why);
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

type CliChain = { holder?: Address | "fail"; fee?: "ok" | "invalid" | "rpc"; race?: TokenRecord };
function cli(store: Store, chain: CliChain = {}) {
  const reads: string[] = [], feeChecks: string[] = [];
  let raced = false;
  const deps: NftReverifyDeps = { chainId: 4663,
    store: { token: (address) => store.token(address), updateNftVerification: (token) => store.updateNftVerification(token),
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
      if (chain.fee !== "ok") throw new NftLaunchError("NFT_FEE_INVALID", "not paid");
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

test("SQLite: a verified write is atomic with the one-coin rule, so the CLI reports CONFLICT instead of a second verified coin", withStore(async (store) => {
  const open = nftCoin(3, { nftVerification: { status: "unverified", reason: "rpc" } });
  const rival = nftCoin(4, { nftVerification: { status: "verified" }, createdAt: 1_800_000_000_100 });
  store.saveToken(open);
  const result = await nftReverifyCommand(["4663", open.address], cli(store, { race: rival }).deps);
  assert.deepEqual(result, { lines: [`CONFLICT ${nftKey(muse)} ${open.address} ${rival.address}`], failed: true });
  assert.deepEqual(store.token(open.address), open, "the guarded write changed nothing");
  // The store method itself: a verified write is refused while another coin holds the NFT; other outcomes still apply.
  store.updateNftVerification({ ...open, nftVerification: { status: "verified" } });
  assert.equal(store.token(open.address)?.nftVerification?.status, "unverified");
  store.updateNftVerification({ ...open, nftVerification: { status: "rejected", reason: "already_launched" } });
  assert.equal(store.token(open.address)?.nftVerification?.reason, "already_launched");
  const elsewhere = nftCoin(5, { nft: { ...muse, tokenId: "2" }, nftVerification: { status: "unverified", reason: "rpc" } });
  store.saveToken(elsewhere);
  store.updateNftVerification({ ...elsewhere, nftVerification: { status: "verified" } });
  assert.equal(store.token(elsewhere.address)?.nftVerification?.status, "verified", "another NFT's coin is no conflict");
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

test("Supabase: the CLI's verified write is followed by a one-coin re-read, and a second verified coin is a CONFLICT failure", async () => {
  const store = new SupabaseStore("https://fixture.supabase.co", "test-server-key", "verify-nft");
  const open = nftCoin(3, { nftVerification: { status: "unverified", reason: "rpc" } }), rival = nftCoin(4, { nftVerification: { status: "verified" } });
  let stored: TokenRecord = open, oneCoinReads = 0;
  const calls: string[] = [];
  store.request = async <T>(raw: string, method = "GET", body?: unknown) => {
    const path = decodeURIComponent(raw);
    calls.push(`${method} ${path}`);
    if (method === "PATCH") {
      if (path.includes("status=eq.unverified") && stored.nftVerification?.status === "unverified") stored = (body as { payload: TokenRecord }).payload;
      return undefined as T;
    }
    if (path.includes("payload->nftVerification->>status=eq.verified")) return (oneCoinReads++ === 0 ? [] : [{ payload: rival }]) as T;
    return [{ payload: stored }] as T;
  };
  const deps: NftReverifyDeps = { ...cli(undefined as never).deps, store };
  const result = await nftReverifyCommand(["4663", open.address], deps);
  assert.deepEqual(result, { lines: [`CONFLICT ${nftKey(muse)} ${open.address} ${rival.address}`], failed: true });
  const patches = calls.map((call, index) => [call, index] as const).filter(([call]) => call.startsWith("PATCH"));
  assert.equal(patches.length, 2);
  for (const [call] of patches) assert(call.includes("payload->>openingValuationUnverified=is.null"), `provenance is matched: ${call}`);
  const reread = calls.at(-1)!;
  assert(calls.length - 1 > patches[1][1], "the one-coin re-read follows the write");
  assert.equal(calls.filter((call) => call === reread).length, 2, "the same one-coin query ran before the write and again after it");
  for (const part of ["GET musegod_tokens?scope=eq.verify-nft", "payload->nft->>chainId=eq.4663", `payload->nft->>contract=ilike.${muse.contract.toLowerCase()}`,
    "payload->nft->>tokenId=eq.1", "payload->nftVerification->>status=eq.verified", `address=neq.${open.address.toLowerCase()}`])
    assert(reread.includes(part), `missing ${part} in ${reread}`);
});
