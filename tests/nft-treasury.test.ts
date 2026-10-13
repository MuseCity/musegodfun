import test from "node:test";
import assert from "node:assert/strict";
import { concat, decodeFunctionData, encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from "viem";
import { sweepTx, deployVaultTx, activateTreasuryTxs, withdrawTx, lockTx, depositTx, isNftTreasuryTx, heldNftCoins, lockTarget, nftBadge,
  NFT_OWNER_SCAN_LIMIT } from "../src/lib/nft-treasury";
import { MUSES, treasuryFor, vaultFor, ERC6551_REGISTRY, TOKENBOUND_V3_PROXY, TOKENBOUND_V3_IMPLEMENTATION, type NftRef } from "../src/lib/nft-mode";
import { allocateFeeIncome, FEE_POLICY } from "../src/lib/fee-policy";
import type { RuntimeConfig } from "../src/lib/config";
import { syntheticToken } from "./fixtures";

const nft = { chainId: 4663 as const, contract: MUSES.contract, tokenId: "1" };
const token = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address, holder = "0xAAaA000000000000000000000000000000000001" as Address;
const accountAbi = parseAbi(["function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)", "function lock(uint256 lockedUntil)",
  "function initialize(address implementation)"]);
const registryAbi = parseAbi(["function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)"]);

test("activation creates the canonical account and initializes Tokenbound V3", () => {
  const [create, init] = activateTreasuryTxs(nft);
  assert.equal(create.to, ERC6551_REGISTRY);
  assert.deepEqual(decodeFunctionData({ abi: registryAbi, data: create.data }).args, [TOKENBOUND_V3_PROXY, `0x${"00".repeat(32)}`, 4663n, MUSES.contract, 1n]);
  assert.equal(init.to, treasuryFor(nft));
  assert.deepEqual(decodeFunctionData({ abi: accountAbi, data: init.data }).args, [TOKENBOUND_V3_IMPLEMENTATION]);
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

test("a lock ends the preset number of days after the latest block", () => {
  assert.equal(lockTarget(1_800_000_000n, 1), 1_800_086_400);
  assert.equal(lockTarget(1_800_000_000n, 30), 1_802_592_000);
});

test("the NFT badge names a Muse or warns about an unverified collection, and a rejected coin has none", () => {
  const coin = (status: "verified" | "unverified" | "rejected", ref: NftRef = nft) => ({ nft: ref, nftVerification: { status } });
  assert.equal(nftBadge(coin("verified")), "Muse #1");
  assert.equal(nftBadge(coin("unverified", other)), "Muse #2");
  assert.equal(nftBadge(coin("verified", { ...nft, contract: "0x9999999999999999999999999999999999999999" })), "NFT #1");
  assert.equal(nftBadge(coin("unverified", { ...nft, contract: "0x9999999999999999999999999999999999999999" })), "NFT · unverified collection");
  assert.equal(nftBadge(coin("rejected")), null);
  assert.equal(nftBadge({}), null);
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
