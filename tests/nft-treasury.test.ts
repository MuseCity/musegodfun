import test from "node:test";
import assert from "node:assert/strict";
import { concat, createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, multicall3Abi, pad, parseAbi,
  stringToHex, toHex, type Address, type Hex } from "viem";
import { sweepTx, deployVaultTx, activateTreasuryTxs, finishActivationTx, withdrawTx, lockTx, depositTx, isNftTreasuryTx, heldNftCoins, lockTarget, nftBadge,
  readTreasuryLock, treasuryInitialized, ERC1967_IMPLEMENTATION_SLOT, NFT_OWNER_SCAN_LIMIT, pendingSweepTxs } from "../src/lib/nft-treasury";
import { MUSES, treasuryFor, vaultFor, ERC6551_REGISTRY, TOKENBOUND_V3_PROXY, TOKENBOUND_V3_IMPLEMENTATION, type NftRef } from "../src/lib/nft-mode";
import { allocateFeeIncome, FEE_POLICY } from "../src/lib/fee-policy";
import type { RuntimeConfig } from "../src/lib/config";
import { syntheticToken } from "./fixtures";

const nft = { chainId: 4663 as const, contract: MUSES.contract, tokenId: "1" };
const token = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address, holder = "0xAAaA000000000000000000000000000000000001" as Address;
const accountAbi = parseAbi(["function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)", "function lock(uint256 lockedUntil)",
  "function initialize(address implementation)"]);
const registryAbi = parseAbi(["function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)"]);

test("treasury sweeps select only nonzero readable fees and split large pool sets into bounded transactions", () => {
  const coins = Array.from({ length: 43 }, (_, n) => ({ token: toHex(n + 1, { size: 20 }), quoteAddress: token,
    poolId: toHex(n + 1, { size: 32 }), symbol: `C${n}` }));
  const pair = { fees0: "0", fees1: "0" };
  const pendingFees = coins.map((coin, n) => n === 1 ? { token: coin.token, error: "RPC down" } : {
    token: coin.token, lp: { ...pair, fees0: n >= 3 && n % 2 === 0 ? "1" : "0" },
    trade: { ...pair, fees1: n >= 3 && n % 2 === 1 ? "2" : "0" }, poolKey: { currency0: coin.token, currency1: token },
  });
  const vault = vaultFor(nft, factory);
  const txs = pendingSweepTxs(vault, { coins, pendingFees, balances: [] });
  assert(txs.length > 1, "one transaction cannot grow with all bound pools");
  const swept: Hex[] = [];
  for (const tx of txs) {
    assert.equal(tx.to, vault);
    const decoded = decodeFunctionData({ abi: parseAbi(["function sweep(bytes32[] poolIds, address[] tokens)"]), data: tx.data });
    const [pools, assets] = decoded.args;
    assert(pools.length <= 5 && assets.length <= 10, "bounded pool and token work");
    swept.push(...pools);
    for (const pool of pools) {
      const coin = coins.find((coin) => coin.poolId === pool)!;
      assert(assets.some((asset) => asset.toLowerCase() === coin.token.toLowerCase()));
      assert(assets.some((asset) => asset.toLowerCase() === token.toLowerCase()));
    }
    assert.equal(allowed(tx), true, "the existing sweep signing guard still accepts each batch");
  }
  assert.deepEqual(swept, coins.slice(3).map((coin) => coin.poolId), "all nonzero pools count, including rejected coins");
  assert.deepEqual(pendingSweepTxs(vault, { coins, pendingFees: pendingFees.slice(0, 3), balances: [] }), [], "no pending funds: disable Sweep");
});

test("treasury sweeps can still forward balances already in the vault without collecting empty pools", () => {
  const vault = vaultFor(nft, factory);
  const txs = pendingSweepTxs(vault, { coins: [], pendingFees: [], balances: [{ token, symbol: "C", amount: "0", vaultAmount: "5" }] });
  assert.equal(txs.length, 1);
  assert.deepEqual(decodeFunctionData({ abi: parseAbi(["function sweep(bytes32[] poolIds, address[] tokens)"]), data: txs[0].data }).args, [[], [token]]);
});

test("activation creates the canonical account and initializes Tokenbound V3", () => {
  const [create, init] = activateTreasuryTxs(nft);
  assert.equal(create.to, ERC6551_REGISTRY);
  assert.deepEqual(decodeFunctionData({ abi: registryAbi, data: create.data }).args, [TOKENBOUND_V3_PROXY, `0x${"00".repeat(32)}`, 4663n, MUSES.contract, 1n]);
  assert.equal(init.to, treasuryFor(nft));
  assert.deepEqual(decodeFunctionData({ abi: accountAbi, data: init.data }).args, [TOKENBOUND_V3_IMPLEMENTATION]);
});

// Round 4 F5: a treasury whose createAccount confirmed but whose initialize did not is told apart from an active one, and finished.
test("the treasury is initialized exactly when its ERC-1967 implementation slot holds Tokenbound V3; finishing sends only the initialize step", () => {
  assert.equal(ERC1967_IMPLEMENTATION_SLOT, toHex(BigInt(keccak256(stringToHex("eip1967.proxy.implementation"))) - 1n, { size: 32 }));
  assert.equal(treasuryInitialized(pad(TOKENBOUND_V3_IMPLEMENTATION, { size: 32 })), true);
  assert.equal(treasuryInitialized(pad(TOKENBOUND_V3_IMPLEMENTATION.toLowerCase() as Hex, { size: 32 })), true);
  for (const value of [undefined, "0x", pad("0x00", { size: 32 }), pad(TOKENBOUND_V3_PROXY, { size: 32 }), "0xnot-hex"] as (Hex | undefined)[])
    assert.equal(treasuryInitialized(value), false, String(value));
  assert.deepEqual(finishActivationTx(nft), activateTreasuryTxs(nft)[1], "exactly the second activation step");
  assert.equal(isNftTreasuryTx({ mode: "robinhood", deploymentChainId: 4663, nftMode: null as never }, nft, { ...finishActivationTx(nft), value: 0n }, holder), true,
    "the guard's own initialize predicate accepts it");
});

test("withdraw executes an ERC-20 transfer from the treasury; lock and deposit target the treasury", () => {
  const w = withdrawTx(nft, token, holder, 5n);
  assert.equal(w.to, treasuryFor(nft));
  const call = decodeFunctionData({ abi: accountAbi, data: w.data });
  assert.equal(call.functionName, "execute");
  assert.equal(call.args[0], token);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: call.args[2] as Hex }).args, [holder, 5n]);
  assert.equal(lockTx(nft, 1_800_000_000).to, treasuryFor(nft));
  const d = depositTx(nft, token, 7n);
  assert.equal(d.to, token);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: d.data }).args, [treasuryFor(nft), 7n]);
  assert.match(sweepTx("0x9999999999999999999999999999999999999999", [`0x${"ab".repeat(32)}`], [token]).data, /^0x/);
});

test("a native withdraw carries the ETH inside execute, never on the outer call", () => {
  const call = decodeFunctionData({ abi: accountAbi, data: withdrawTx(nft, "native", holder, 9n).data });
  assert.deepEqual(call.args, [holder, 9n, "0x", 0]);
  assert.deepEqual(decodeFunctionData({ abi: accountAbi, data: lockTx(nft, 1_800_000_000).data }).args, [1_800_000_000n]);
});

// ---- the signing allowlist ----------------------------------------------------------------------
const factory = "0xFac7000000000000000000000000000000000001" as Address, otherFactory = "0xFAC7000000000000000000000000000000000002" as Address;
const config: Pick<RuntimeConfig, "mode" | "deploymentChainId" | "nftMode"> = { mode: "robinhood", deploymentChainId: 4663,
  nftMode: { enabled: true, vaultFactory: factory, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } };
const poolId = `0x${"ab".repeat(32)}` as Hex, quote = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const other: NftRef = { ...nft, tokenId: "2" };
const allowed = (tx: { to: Address; data: Hex; value?: bigint }, ref: NftRef = nft, settings = config, account = holder) =>
  isNftTreasuryTx(settings, ref, { to: tx.to, data: tx.data, value: tx.value ?? 0n }, account);
const legitimate = () => [deployVaultTx(factory, nft), sweepTx(vaultFor(nft, factory), [poolId], [token, quote]), ...activateTreasuryTxs(nft),
  withdrawTx(nft, token, holder, 5n), withdrawTx(nft, "native", holder, 5n), lockTx(nft, 1_800_000_000), depositTx(nft, token, 7n)];

test("the signing allowlist accepts exactly the NFT's deploy, sweep, activation, withdraw, lock and deposit", () => {
  for (const tx of legitimate()) assert.equal(allowed(tx), true, tx.data.slice(0, 10));
  // Addresses are compared case-insensitively and the NFT may be written in any case.
  assert.equal(allowed({ ...deployVaultTx(factory, nft), to: factory.toLowerCase() as Address }), true);
  assert.equal(allowed(depositTx(nft, token, 7n), { ...nft, contract: nft.contract.toLowerCase() as Address }), true);
});

test("the signing allowlist refuses a wrong vault, token id, implementation, recipient, operation, outer value or selector", () => {
  const refused = (tx: { to: Address; data: Hex; value?: bigint }, label: string, ref: NftRef = nft, settings = config) =>
    assert.equal(allowed(tx, ref, settings), false, label);
  // Wrong vault: another NFT's vault, another factory's vault, or the factory itself.
  refused(sweepTx(vaultFor(other, factory), [poolId], [token]), "another NFT's vault");
  refused(sweepTx(vaultFor(nft, otherFactory), [poolId], [token]), "another factory's vault");
  refused({ to: factory, data: sweepTx(factory, [poolId], [token]).data }, "sweep sent to the factory");
  refused(deployVaultTx(otherFactory, nft), "an unverified factory");
  // Wrong token id: every action built for token 2 while acting on token 1.
  refused(deployVaultTx(factory, other), "deploy for another token id");
  for (const tx of activateTreasuryTxs(other)) refused(tx, "activation for another token id");
  refused(lockTx(other, 1_800_000_000), "lock of another treasury");
  refused(withdrawTx(other, token, holder, 5n), "withdraw from another treasury");
  refused(depositTx(other, token, 7n), "deposit into another treasury");
  refused({ ...withdrawTx(nft, token, holder, 5n), to: treasuryFor({ ...nft, chainId: 8453 }) }, "the same id on another chain");
  // Wrong implementation or salt.
  refused({ to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "initialize", args: [TOKENBOUND_V3_PROXY] }) }, "initialize to the proxy");
  refused({ to: ERC6551_REGISTRY, data: encodeFunctionData({ abi: registryAbi, functionName: "createAccount",
    args: [TOKENBOUND_V3_IMPLEMENTATION, `0x${"00".repeat(32)}`, 4663n, nft.contract, 1n] }) }, "createAccount with the implementation");
  refused({ to: ERC6551_REGISTRY, data: encodeFunctionData({ abi: registryAbi, functionName: "createAccount",
    args: [TOKENBOUND_V3_PROXY, `0x${"00".repeat(31)}01`, 4663n, nft.contract, 1n] }) }, "createAccount with another salt");
  // A non-zero outer value on any allowed call.
  for (const tx of legitimate()) refused({ ...tx, value: 1n }, `outer value on ${tx.data.slice(0, 10)}`);
  // A transfer to a different recipient, or a withdraw to anyone but the connected wallet.
  refused({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [holder, 7n] }) }, "transfer to the holder");
  refused({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [vaultFor(nft, factory), 7n] }) }, "transfer to the vault");
  refused(withdrawTx(nft, token, "0xBbbb000000000000000000000000000000000002", 5n), "withdraw to another wallet");
  refused(withdrawTx(nft, "native", "0xBbbb000000000000000000000000000000000002", 5n), "native withdraw to another wallet");
  // Treasury calls that are not a plain withdraw: a delegatecall, an approval, or arbitrary calldata.
  refused({ to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [holder, 5n, "0x", 1] }) }, "delegatecall");
  refused({ to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "execute",
    args: [token, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [holder, 5n] }), 0] }) }, "execute approve");
  refused({ to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [token, 1n, "0x", 0] }) }, "ETH sent to a token");
  refused({ to: treasuryFor(nft), data: encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [holder, 5n, "0x12", 0] }) }, "native withdraw with calldata");
  // Unknown selectors and padded calldata.
  refused({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [treasuryFor(nft), 7n] }) }, "approve to the token");
  refused({ to: treasuryFor(nft), data: "0xdeadbeef" }, "unknown selector to the treasury");
  refused({ to: token, data: "0x" }, "empty calldata");
  // A legacy collection with transfer(address,uint256) would send the NFT into its own treasury: the ownership cycle.
  refused({ to: nft.contract, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [treasuryFor(nft), 1n] }) }, "the NFT into its treasury");
  refused({ to: nft.contract.toLowerCase() as Address, data: depositTx(nft, nft.contract, 1n).data }, "the NFT into its treasury, lower case");
  refused({ to: ERC6551_REGISTRY, data: concat([activateTreasuryTxs(nft)[0].data, "0x00"]) }, "trailing bytes");
  refused({ to: treasuryFor(nft), data: concat([lockTx(nft, 1_800_000_000).data, "0x00"]) }, "lock with trailing bytes");
  refused({ to: token, data: concat([depositTx(nft, token, 7n).data, `0x${"00".repeat(32)}`]) }, "deposit with trailing bytes");
  // No verified factory: neither deploy nor sweep. Another network's NFT: nothing.
  const noFactory = { ...config, nftMode: { ...config.nftMode!, vaultFactory: null } };
  refused(deployVaultTx(factory, nft), "deploy without a verified factory", nft, noFactory);
  refused(sweepTx(vaultFor(nft, factory), [poolId], [token]), "sweep without a verified factory", nft, noFactory);
  const baseNft: NftRef = { ...nft, chainId: 8453 };
  refused(depositTx(baseNft, token, 7n), "an NFT on another network", baseNft);
});

// ---- reads -------------------------------------------------------------------------------------
test("the holder's NFT coins come from one ownerOf multicall over at most the first 200 NFT coins", async () => {
  const contract = "0x9999999999999999999999999999999999999999" as Address;
  const coins = Array.from({ length: NFT_OWNER_SCAN_LIMIT + 5 }, (_, index) => syntheticToken({
    address: `0x${(index + 1).toString(16).padStart(40, "0")}` as Address, nft: { chainId: 4663, contract, tokenId: String(index % 150) } }));
  const plain = syntheticToken({ address: "0x00000000000000000000000000000000000000ff" });
  const calls: { contracts: readonly { address: Address; args: readonly unknown[] }[] }[] = [];
  const client = { multicall: async (request: { contracts: readonly { address: Address; args: readonly unknown[] }[] }) => {
    calls.push(request);
    return request.contracts.map((call) => Number(call.args[0]) === 3 ? { status: "failure" as const, error: new Error("burned") }
      : { status: "success" as const, result: Number(call.args[0]) % 2 ? holder : "0xBbbb000000000000000000000000000000000002" });
  } };
  const result = await heldNftCoins(client as never, [plain, ...coins], holder);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contracts.length, 150, "the first 200 coins hold 150 distinct NFTs");
  assert.equal(result.capped, true);
  assert.equal(result.held.every(({ nft }) => Number(nft.tokenId) % 2 === 1 && nft.tokenId !== "3"), true);
  assert.equal(result.held.length, 74);
  assert.equal(result.held.find(({ nft }) => nft.tokenId === "1")!.coins.length, 2, "both coins of NFT #1 in the first 200");
  const none = await heldNftCoins(client as never, [plain], holder);
  assert.deepEqual(none, { held: [], capped: false });
  assert.equal(calls.length, 1, "no NFT coins, no read");
});

test("200 ownerOf reads and the lock read each reach the RPC proxy as exactly one request", async () => {
  let requests = 0;
  const client = createPublicClient({ transport: custom({ async request({ method, params }: { method: string; params: [{ data: Hex }] }) {
    requests++;
    assert.equal(method, "eth_call");
    const [calls] = decodeFunctionData({ abi: multicall3Abi, data: params[0].data }).args as unknown as [readonly { callData: Hex }[]];
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls.map(({ callData }) => ({ success: true,
      returnData: callData.startsWith("0x6352211e") ? encodeAbiParameters([{ type: "address" }], [holder]) : encodeAbiParameters([{ type: "uint256" }], [0n]) })) });
  } }) });
  const coins = Array.from({ length: NFT_OWNER_SCAN_LIMIT }, (_, index) => syntheticToken({
    address: `0x${(index + 1).toString(16).padStart(40, "0")}` as Address, nft: { chainId: 4663, contract: MUSES.contract, tokenId: String(index) } }));
  const result = await heldNftCoins(client, coins, holder);
  assert.equal(requests, 1, "one eth_call for 200 NFTs (no 1024-byte chunking)");
  assert.equal(result.held.length, NFT_OWNER_SCAN_LIMIT);
  requests = 0;
  assert.deepEqual(await readTreasuryLock(client, nft), { lockedUntil: 0, locked: false });
  assert.equal(requests, 1);
});

test("a lock ends the preset number of days after the latest block", () => {
  assert.equal(lockTarget(1_800_000_000n, 1), 1_800_086_400);
  assert.equal(lockTarget(1_800_000_000n, 30), 1_802_592_000);
});

test("the NFT badge follows the collection allowlist, never the coin's status; a rejected coin has none", () => {
  const coin = (status: "verified" | "unverified" | "rejected" | undefined, ref: NftRef = nft) => ({ nft: ref, ...(status ? { nftVerification: { status } } : {}) });
  const foreign = { ...nft, contract: "0x9999999999999999999999999999999999999999" as Address };
  assert.equal(nftBadge(coin("verified")), "Muse #1");
  assert.equal(nftBadge(coin("unverified", other)), "Muse #2");
  assert.equal(nftBadge(coin(undefined, other)), "Muse #2", "a record without a status is unverified");
  for (const status of ["verified", "unverified", undefined] as const)
    assert.equal(nftBadge(coin(status, foreign)), "NFT · unverified collection", `a ${status ?? "status-less"} coin of another collection still warns`);
  assert.equal(nftBadge(coin("rejected")), null);
  assert.equal(nftBadge(coin("rejected", foreign)), null);
  assert.equal(nftBadge({}), null);
  // Where space allows (the NFT page and the token header), an unverified collection names its contract (D7).
  assert.equal(nftBadge(coin("verified", foreign), { withContract: true }), "NFT · unverified collection · 0x9999…9999");
  assert.equal(nftBadge(coin("verified"), { withContract: true }), "Muse #1", "the allowlisted Muses need no address");
});

// ---- fee allocation ----------------------------------------------------------------------------
test("an NFT coin's creator bucket is its fee vault, labelled NFT treasury, and a missing factory never throws", () => {
  const launcher = "0x2222222222222222222222222222222222222222" as Address, platform = "0x3333333333333333333333333333333333333333" as Address;
  const coin = { feePolicy: FEE_POLICY, amount: 100n, creator: launcher, treasury: platform, nft };
  assert.deepEqual(allocateFeeIncome({ ...coin, account: vaultFor(nft, factory), vaultFactory: factory }),
    { creator: 100n, platform: 0n, buyback: 0n, operations: 0n, remainder: 0n, creatorLabel: "NFT treasury" });
  assert.equal(allocateFeeIncome({ ...coin, account: launcher, vaultFactory: factory }), null, "the launcher is not the beneficiary");
  for (const vaultFactory of [null, undefined]) {
    const platformShare = allocateFeeIncome({ ...coin, account: platform, vaultFactory });
    assert.equal(platformShare?.creator, 0n);
    assert.equal(platformShare?.platform, 100n);
    assert.equal(platformShare?.creatorLabel, "NFT treasury");
    assert.equal(allocateFeeIncome({ ...coin, account: launcher, vaultFactory }), null);
  }
  // A normal coin keeps its creator and has no label.
  assert.deepEqual(allocateFeeIncome({ feePolicy: FEE_POLICY, amount: 100n, creator: launcher, treasury: platform, account: launcher }),
    { creator: 100n, platform: 0n, buyback: 0n, operations: 0n, remainder: 0n });
});
