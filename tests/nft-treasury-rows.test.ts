import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, erc721Abi, getAddress, parseAbi, type Address, type Hex } from "viem";
import { explorerFor, type RuntimeConfig } from "../src/lib/config";
import { MUSES, treasuryFor } from "../src/lib/nft-mode";
import { LOCK_NOTE, collectionRow, officialCoinRow, readNftHolder, treasuryStatusRow, withdrawalLockRow } from "../src/lib/nft-treasury";
import { syntheticToken } from "./fixtures";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

// tasks/token-ip-detail-plan.md §14: every treasury card row says what it describes.
const muse = { chainId: 4663 as const, contract: MUSES.contract, tokenId: "610" };
const other = { chainId: 4663 as const, contract: "0x5555555555555555555555555555555555555555" as Address, tokenId: "7" };
const holder = getAddress("0xc8b1000000000000000000000000000000c8056b");

test("the Collection row names the collection and says what verified means", () => {
  assert.deepEqual(collectionRow(muse, true), { value: "Muses · verified", note: "The official Muses contract, on musegod.fun's verified list." });
  assert.deepEqual(collectionRow(other, true), { value: "Verified", note: "This NFT contract is on musegod.fun's verified list." });
  const unverified = collectionRow(other, false);
  assert.equal(unverified.value, "Unverified");
  assert.equal(unverified.warning, true);
  assert.match(unverified.note!, /look-alike collection, so check the contract address/);
});

test("the Official coin row explains each registration status and reason in words, never as a code", () => {
  assert.deepEqual(officialCoinRow({ status: "verified" }),
    { value: "Yes", note: "This NFT's one verified coin, launched by its holder or the holder's delegate. Each NFT gets one." });
  const rejected = {
    already_launched: "Another coin was verified for this NFT first.",
    not_controller: "The wallet that launched it did not control the NFT.",
    not_erc721: "The bound contract is not an ERC-721 NFT.",
    fee: "The launch fee was not paid.",
    pair: "Its pair was not allowed when it launched.",
  };
  for (const [reason, text] of Object.entries(rejected)) {
    assert.deepEqual(officialCoinRow({ status: "rejected", reason }), { value: "No", warning: true, note: `${text} Its creator fees still go to this NFT's vault.` });
  }
  assert.equal(officialCoinRow({ status: "rejected", reason: "custom" }).note, "Reason: custom. Its creator fees still go to this NFT's vault.");
  assert.equal(officialCoinRow({ status: "rejected", reason: "toString" }).note, "Reason: toString. Its creator fees still go to this NFT's vault.",
    "a stored reason never reads an object prototype key");
  assert.equal(officialCoinRow({ status: "rejected" }).note, "No reason was recorded. Its creator fees still go to this NFT's vault.");
  assert.deepEqual(officialCoinRow({ status: "unverified", reason: "rpc" }),
    { value: "Not confirmed yet", note: "The chain could not be read at launch, so the holder check did not finish." });
  assert.equal(officialCoinRow({ status: "unverified", reason: "fee_unconfirmed" }).note, "The launch fee payment is not confirmed yet.");
  for (const status of [undefined, { status: "unverified" as const }]) {
    assert.deepEqual(officialCoinRow(status), { value: "Not confirmed yet", note: "musegod.fun has not confirmed that the NFT's holder launched it." });
  }
});

test("treasury status and the withdrawal lock are two rows, and the lock always says what it does", () => {
  assert.deepEqual(treasuryStatusRow("reading"), { value: "Reading…" });
  assert.deepEqual(treasuryStatusRow("unavailable"), { value: "Unavailable" });
  assert.deepEqual(treasuryStatusRow("not_deployed"),
    { value: "Not activated yet", note: "Swept fees still arrive at its address. It needs one activation before the holder can withdraw." });
  assert.deepEqual(treasuryStatusRow("not_initialized"), { value: "Activation not finished", note: "Withdraw and Lock open once the activation finishes." });
  assert.deepEqual(treasuryStatusRow("active"), { value: "Active" });
  const date = (seconds: number) => `T${seconds}`, on = { lockedUntil: 1_800_000_000, locked: true }, off = { lockedUntil: 0, locked: false };
  const value = (...args: Parameters<typeof withdrawalLockRow>) => withdrawalLockRow(...args).value;
  assert.equal(value("reading", null, "", date), "Reading…");
  assert.equal(value("unavailable", null, "", date), "Unavailable");
  assert.equal(value("not_deployed", null, "", date), "Off", "an account that is not activated cannot be locked");
  assert.equal(value("not_initialized", null, "", date), "Off");
  assert.equal(value("active", null, "", date), "Reading…");
  assert.equal(value("active", null, "RPC down", date), "Unavailable");
  assert.equal(value("active", off, "", date), "Off");
  assert.deepEqual(withdrawalLockRow("active", on, "", date), { value: "On until T1800000000", note: LOCK_NOTE, warning: true });
  for (const state of ["reading", "not_deployed", "active"] as const) assert.equal(withdrawalLockRow(state, null, "", date).note, LOCK_NOTE);
  assert.match(LOCK_NOTE, /cannot send anything until the date, even for its holder.*while selling the NFT\. Approvals it gave earlier still work\./,
    "a lock stops the account, not token approvals it gave before");
});

const aggregate3Abi = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)"]);
/** A real viem client whose RPC answers every eth_call with one aggregate3 entry, or fails. */
function rpcClient(entry: { success: boolean; returnData: Hex } | Error) {
  return createPublicClient({ transport: custom({ async request({ method, params }: any) {
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    if (entry instanceof Error) throw entry;
    const [calls] = decodeFunctionData({ abi: aggregate3Abi, data: params[0].data }).args as any;
    assert.equal(calls[0].target, muse.contract);
    assert.deepEqual(decodeFunctionData({ abi: erc721Abi, data: calls[0].callData }), { functionName: "ownerOf", args: [610n] });
    return encodeFunctionResult({ abi: aggregate3Abi, functionName: "aggregate3", result: [entry] });
  } }), retryCount: 0 } as any);
}
test("the public holder read tells the chain's answer from a failed read", async () => {
  const owner = (address: Address) => encodeFunctionResult({ abi: erc721Abi, functionName: "ownerOf", result: address });
  assert.equal(await readNftHolder(rpcClient({ success: true, returnData: owner(holder) }), muse), holder);
  assert.equal(await readNftHolder(rpcClient({ success: false, returnData: "0x" }), muse), null, "ownerOf reverted: a burned token");
  assert.equal(await readNftHolder(rpcClient({ success: true, returnData: "0x" }), muse), null, "no code at the collection address");
  assert.equal(await readNftHolder(rpcClient({ success: true, returnData: "0x01" }), muse), null, "an answer that is not an address");
  assert.equal(await readNftHolder(rpcClient({ success: true, returnData: owner("0x0000000000000000000000000000000000000000") }), muse), null);
  await assert.rejects(readNftHolder(rpcClient(new Error("RPC down")), muse), /RPC down/, "a failed read is never reported as no holder");
});

const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: true, blockReason: null,
  nftMode: { enabled: true, vaultFactory: "0x4444444444444444444444444444444444444444", launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } } as unknown as RuntimeConfig;
const coin = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, nft: muse, nftVerification: { status: "verified" } });

/** The token page's treasury card with the wallet, the treasury view and the chain at fixture boundaries. */
async function card(options: { account?: Address | null; owner?: () => Address | null; initialized?: boolean; status?: () => Promise<any> } = {}) {
  let View: any, ownerReads = 0;
  const view = { nft: muse, vault: "0x6666666666666666666666666666666666666666", vaultDeployed: false, treasury: treasuryFor(muse), treasuryDeployed: !!options.initialized,
    treasuryInitialized: !!options.initialized, coins: [], balances: [], pendingFees: [] };
  const multicall = async () => [{ status: "success", result: 0n }, { status: "success", result: false }];
  const readContract = async ({ functionName }: any) => {
    assert.equal(functionName, "aggregate3");
    ownerReads++;
    const owner = (options.owner ?? (() => holder))();
    return [owner ? { success: true, returnData: encodeFunctionResult({ abi: erc721Abi, functionName: "ownerOf", result: owner }) } : { success: false, returnData: "0x" }];
  };
  const runtime = hookRuntime(() => View({ config, nft: muse, coins: [coin], coin, onTokenPage: true }));
  ({ NftTreasuryCard: View } = await importFresh("src/components/NftCoinCard.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: {
      useWallet: () => ({ account: options.account ?? null, chainId: 4663, connecting: false, connect() {} }), transactionClient: () => ({ multicall, readContract }) } },
    "../lib/api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async () => view } },
    "../lib/nft-client": { file: import.meta.resolve("../src/lib/nft-client.ts"), bindings: {
      readNftStatus: options.status ?? (async () => ({ erc721: true, owner: holder, controls: true, alreadyLaunched: true, free: true })) } },
  }));
  runtime.render(); await settle(); await settle();
  return { html: () => renderToStaticMarkup(runtime.output()), ownerReads: () => ownerReads, unmount: runtime.unmount };
}
const row = (html: string, label: string) => html.match(new RegExp(`<div[^>]*><dt>${label}</dt>(.*?)</div>`))?.[1] ?? "";

test("a visitor without a wallet sees the NFT's current holder, read once in public, never a prompt to connect", async () => {
  const visitor = await card();
  try {
    const html = visitor.html();
    assert.doesNotMatch(html, /Connect a wallet to check|Coin status|Treasury lock/);
    assert(row(html, "Current holder").includes(`href="${explorerFor(config)}/address/${holder}"`), "the holder links to the explorer");
    assert.doesNotMatch(row(html, "Current holder"), /\(you\)/);
    assert.equal(visitor.ownerReads(), 1);
    assert.match(row(html, "Collection"), /Muses · verified.*class="row-note">The official Muses contract/);
    assert.match(row(html, "Official coin"), /<dd class="sans">Yes<\/dd><dd class="row-note">This NFT&#x27;s one verified coin/);
    assert.match(row(html, "Treasury status"), /Not activated yet.*Swept fees still arrive at its address/);
    assert.match(row(html, "Withdrawal lock"), /<dd class="sans">Off<\/dd><dd class="row-note">While on, the treasury cannot send anything/);
  } finally { visitor.unmount(); }
});

test("the holder's own wallet is marked, a burned NFT has no holder and a failed read says so", async () => {
  const mine = await card({ account: holder });
  try {
    assert.match(row(mine.html(), "Current holder"), /↗<\/a><span class="sans"> \(you\)<\/span>/);
    assert.equal(mine.ownerReads(), 0, "a connected wallet keeps the /nft-status read");
  } finally { mine.unmount(); }
  const burned = await card({ owner: () => null });
  try {
    assert.match(row(burned.html(), "Current holder"), /<dd>None<\/dd>/);
    assert.match(burned.html(), /This NFT has no holder, so its treasury cannot be used/);
  } finally { burned.unmount(); }
  const failed = await card({ owner: () => { throw new Error("RPC down"); } });
  try { assert.match(row(failed.html(), "Current holder"), /<dd>Unavailable<\/dd>/); } finally { failed.unmount(); }
});

test("a visitor of an activated treasury is told only the holder can withdraw, not that the holder is still being checked", async () => {
  const visitor = await card({ initialized: true });
  try {
    const html = visitor.html();
    assert.match(html, /Only the NFT holder can withdraw or lock the treasury\./);
    assert.doesNotMatch(html, /Checking the NFT holder/);
    assert.equal(row(html, "Treasury status"), '<dd class="sans">Active</dd>', "an active treasury needs no note");
    assert.match(row(html, "Withdrawal lock"), /<dd class="sans">Off<\/dd>/);
  } finally { visitor.unmount(); }
  const waiting = await card({ account: "0x7777777777777777777777777777777777777777", initialized: true, status: () => new Promise(() => {}) });
  try { assert.match(waiting.html(), /Checking the NFT holder…/, "a connected wallet still waits for its own holder check"); } finally { waiting.unmount(); }
});
