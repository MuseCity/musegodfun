import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, erc721Abi, getAddress, parseAbi, type Address, type Hex } from "viem";
import { explorerFor, type RuntimeConfig } from "../src/lib/config";
import { MUSES, treasuryFor } from "../src/lib/nft-mode";
import { LOCK_TIP, collectionName, collectionRow, officialCoinRow, readNftPublic, treasuryStatusRow, withdrawalLockRow } from "../src/lib/nft-treasury";
import { syntheticToken } from "./fixtures";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

// tasks/token-ip-detail-plan.md §14 and §15: every treasury card row says what it describes; its explanation sits in an info tip.
const muse = { chainId: 4663 as const, contract: MUSES.contract, tokenId: "610" };
const other = { chainId: 4663 as const, contract: "0x5555555555555555555555555555555555555555" as Address, tokenId: "7" };
const holder = getAddress("0xc8b1000000000000000000000000000000c8056b");

test("the Collection row shows the collection's name; what verified means is in its tip", () => {
  const museTip = "The official Muses contract, on musegod.fun's verified list.";
  assert.deepEqual(collectionRow(muse, true, "MUSEGOD Muses"), { value: "MUSEGOD Muses", tip: museTip });
  assert.deepEqual(collectionRow(muse, true, undefined), { value: "Reading…", tip: museTip });
  assert.deepEqual(collectionRow(muse, true, null), { value: "0x13Ea…9836", tip: museTip }, "without a name the short contract address stands in");
  assert.deepEqual(collectionRow(other, true, "Cakes"), { value: "Cakes", tip: "This collection's contract is on musegod.fun's verified list." });
  const lookalike = "Not on musegod.fun's verified list. Anyone can deploy a look-alike collection with the same name, so check the contract address.";
  assert.deepEqual(collectionRow(other, false, "MUSEGOD Muses"), { value: "MUSEGOD Muses · unverified", warning: true, tip: lookalike },
    "an unverified name keeps a visible marker (D7)");
  assert.deepEqual(collectionRow(other, false, null), { value: "0x5555…5555 · unverified", warning: true, tip: lookalike });
  assert.deepEqual(collectionRow(other, false, undefined), { value: "Reading…", tip: lookalike });
});

test("a collection name from the contract is tidied before it is shown", () => {
  assert.equal(collectionName("  MUSEGOD   Muses \n"), "MUSEGOD Muses");
  assert.equal(collectionName("Mu\u202eses\u200b\u0000"), "Mu ses", "direction overrides, zero-width and control characters are removed");
  assert.equal(collectionName(" \u200b\t "), null);
  assert.equal(collectionName("\u00ad\u034f\u061c\u180e"), null, "a name of invisible characters falls back to the address");
  assert.equal(collectionName("x".repeat(48)), "x".repeat(48));
  assert.equal(collectionName("x".repeat(49)), `${"x".repeat(47)}…`);
  assert.equal(collectionName("🐸".repeat(60)), `${"🐸".repeat(47)}…`, "characters, not UTF-16 units, are counted");
});

test("the Official coin row explains each registration status and reason in words, never as a code", () => {
  assert.deepEqual(officialCoinRow({ status: "verified" }),
    { value: "Yes", tip: "This NFT's one verified coin, launched by its holder or the holder's delegate. Each NFT gets one." });
  const rejected = {
    already_launched: "Another coin was verified for this NFT first.",
    not_controller: "The wallet that launched it did not control the NFT.",
    not_erc721: "The bound contract is not an ERC-721 NFT.",
    fee: "The launch fee was not paid.",
    pair: "Its pair was not allowed when it launched.",
  };
  for (const [reason, text] of Object.entries(rejected)) {
    assert.deepEqual(officialCoinRow({ status: "rejected", reason }), { value: "No", warning: true, tip: `${text} Its creator fees still go to this NFT's vault.` });
  }
  assert.equal(officialCoinRow({ status: "rejected", reason: "custom" }).tip, "Reason: custom. Its creator fees still go to this NFT's vault.");
  assert.equal(officialCoinRow({ status: "rejected", reason: "toString" }).tip, "Reason: toString. Its creator fees still go to this NFT's vault.",
    "a stored reason never reads an object prototype key");
  assert.equal(officialCoinRow({ status: "rejected" }).tip, "No reason was recorded. Its creator fees still go to this NFT's vault.");
  assert.deepEqual(officialCoinRow({ status: "unverified", reason: "rpc" }),
    { value: "Not confirmed yet", tip: "The chain could not be read at launch, so the holder check did not finish." });
  assert.equal(officialCoinRow({ status: "unverified", reason: "fee_unconfirmed" }).tip, "The launch fee payment is not confirmed yet.");
  for (const status of [undefined, { status: "unverified" as const }]) {
    assert.deepEqual(officialCoinRow(status), { value: "Not confirmed yet", tip: "musegod.fun has not confirmed that the NFT's holder launched it." });
  }
});

test("treasury status and the withdrawal lock are two rows, and the lock always says what it does", () => {
  assert.deepEqual(treasuryStatusRow("reading"), { value: "Reading…" });
  assert.deepEqual(treasuryStatusRow("unavailable"), { value: "Unavailable" });
  assert.deepEqual(treasuryStatusRow("not_deployed"),
    { value: "Not activated yet", tip: "Swept fees still arrive at its address. It needs one activation before the holder can withdraw." });
  assert.deepEqual(treasuryStatusRow("not_initialized"), { value: "Activation not finished", tip: "Withdraw and Lock open once the activation finishes." });
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
  assert.deepEqual(withdrawalLockRow("active", on, "", date), { value: "On until T1800000000", tip: LOCK_TIP, warning: true });
  for (const state of ["reading", "not_deployed", "active"] as const) assert.equal(withdrawalLockRow(state, null, "", date).tip, LOCK_TIP);
  assert.match(LOCK_TIP, /cannot send anything until the date, even for its holder.*while selling the NFT\. Approvals it gave earlier still work\./,
    "a lock stops the account, not token approvals it gave before");
});

const aggregate3Abi = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)"]);
type Entry = { success: boolean; returnData: Hex };
const ownerEntry = (address: Address): Entry => ({ success: true, returnData: encodeFunctionResult({ abi: erc721Abi, functionName: "ownerOf", result: address }) });
const nameEntry = (name: string): Entry => ({ success: true, returnData: encodeFunctionResult({ abi: erc721Abi, functionName: "name", result: name }) });
const reverted: Entry = { success: false, returnData: "0x" };
/** A real viem client whose RPC answers every eth_call with the aggregate3 entries for ownerOf and name(), or fails. */
function rpcClient(entries: [Entry, Entry] | Error) {
  return createPublicClient({ transport: custom({ async request({ method, params }: any) {
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    if (entries instanceof Error) throw entries;
    const [calls] = decodeFunctionData({ abi: aggregate3Abi, data: params[0].data }).args as any;
    assert.deepEqual(calls.map((call: any) => [call.target, call.allowFailure]), [[muse.contract, true], [muse.contract, true]]);
    assert.deepEqual(decodeFunctionData({ abi: erc721Abi, data: calls[0].callData }), { functionName: "ownerOf", args: [610n] });
    assert.equal(decodeFunctionData({ abi: erc721Abi, data: calls[1].callData }).functionName, "name");
    return encodeFunctionResult({ abi: aggregate3Abi, functionName: "aggregate3", result: entries });
  } }), retryCount: 0 } as any);
}
test("the public read returns the holder and the collection's name, and tells the chain's answer from a failed read", async () => {
  assert.deepEqual(await readNftPublic(rpcClient([ownerEntry(holder), nameEntry("MUSEGOD Muses")]), muse), { holder, collection: "MUSEGOD Muses" });
  assert.deepEqual(await readNftPublic(rpcClient([reverted, nameEntry(" Cakes\u202e ")]), muse), { holder: null, collection: "Cakes" },
    "ownerOf reverted: a burned token; the name is tidied");
  assert.deepEqual(await readNftPublic(rpcClient([{ success: true, returnData: "0x" }, { success: true, returnData: "0x" }]), muse), { holder: null, collection: null },
    "no code at the collection address");
  assert.deepEqual(await readNftPublic(rpcClient([{ success: true, returnData: "0x01" }, reverted]), muse), { holder: null, collection: null },
    "an answer that is not an address; a contract without name()");
  assert.deepEqual(await readNftPublic(rpcClient([ownerEntry("0x0000000000000000000000000000000000000000"), nameEntry("   ")]), muse), { holder: null, collection: null });
  assert.deepEqual(await readNftPublic(rpcClient([ownerEntry(holder), reverted]), muse), { holder, collection: null }, "a failed name never loses the holder");
  assert.deepEqual(await readNftPublic(rpcClient([ownerEntry(holder), { success: true, returnData: "0x1234" }]), muse), { holder, collection: null });
  await assert.rejects(readNftPublic(rpcClient(new Error("RPC down")), muse), /RPC down/, "a failed read is never reported as no holder or no name");
});

const config = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: true, blockReason: null,
  nftMode: { enabled: true, vaultFactory: "0x4444444444444444444444444444444444444444", launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } } as unknown as RuntimeConfig;
const coin = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, nft: muse, nftVerification: { status: "verified" } });

/** The token page's treasury card with the wallet, the treasury view and the chain at fixture boundaries. */
async function card(options: { account?: Address | null; owner?: () => Address | null; name?: string; initialized?: boolean; status?: () => Promise<any> } = {}) {
  let View: any, publicReads = 0, account = options.account ?? null;
  const view = { nft: muse, vault: "0x6666666666666666666666666666666666666666", vaultDeployed: false, treasury: treasuryFor(muse), treasuryDeployed: !!options.initialized,
    treasuryInitialized: !!options.initialized, coins: [], balances: [], pendingFees: [] };
  const multicall = async () => [{ status: "success", result: 0n }, { status: "success", result: false }];
  const readContract = async ({ functionName }: any) => {
    assert.equal(functionName, "aggregate3");
    publicReads++;
    const owner = (options.owner ?? (() => holder))();
    return [owner ? ownerEntry(owner) : reverted, nameEntry(options.name ?? "MUSEGOD Muses")];
  };
  const runtime = hookRuntime(() => View({ config, nft: muse, coins: [coin], coin, onTokenPage: true }));
  ({ NftTreasuryCard: View } = await importFresh("src/components/NftCoinCard.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: {
      useWallet: () => ({ account, chainId: 4663, connecting: false, connect() {} }), transactionClient: () => ({ multicall, readContract }) } },
    "../lib/api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async () => view } },
    "../lib/nft-client": { file: import.meta.resolve("../src/lib/nft-client.ts"), bindings: {
      readNftStatus: options.status ?? (async () => ({ erc721: true, owner: (options.owner ?? (() => holder))(), controls: true, alreadyLaunched: true, free: true })) } },
  }));
  runtime.render(); await settle(); await settle();
  return { html: () => renderToStaticMarkup(runtime.output()), publicReads: () => publicReads, unmount: runtime.unmount,
    async setAccount(next: Address | null) { account = next; runtime.render(); await settle(); await settle(); } };
}
/** A row's value (its dd) and the text of the info tip after its label, if any. */
const row = (html: string, label: string) => {
  const [, dt = "", dd = ""] = html.match(new RegExp(`<div><dt>${label}(.*?)</dt>(.*?)</div>`)) ?? [];
  return { value: dd, tip: dt.match(/<span role="tooltip" id="[^"]+" class="info-tip-text">(.*?)<\/span>/)?.[1] ?? null,
    button: dt.match(/aria-label="([^"]+)"/)?.[1] ?? null };
};

test("a visitor without a wallet sees the collection's name and the NFT's current holder, read once in public, with explanations in info tips", async () => {
  const visitor = await card();
  try {
    const html = visitor.html();
    assert.doesNotMatch(html, /Connect a wallet to check|Coin status|Treasury lock|Muses · verified|row-note/);
    assert(row(html, "Current holder").value.includes(`href="${explorerFor(config)}/address/${holder}"`), "the holder links to the explorer");
    assert.doesNotMatch(row(html, "Current holder").value, /\(you\)/);
    assert.equal(visitor.publicReads(), 1);
    assert.deepEqual(row(html, "Collection"), { value: '<dd class="sans">MUSEGOD Muses</dd>', button: "About collection",
      tip: "The official Muses contract, on musegod.fun&#x27;s verified list." });
    assert.deepEqual(row(html, "Official coin"), { value: '<dd class="sans">Yes</dd>', button: "About official coin",
      tip: "This NFT&#x27;s one verified coin, launched by its holder or the holder&#x27;s delegate. Each NFT gets one." });
    assert.deepEqual(row(html, "Treasury status"), { value: '<dd class="sans">Not activated yet</dd>', button: "About treasury status",
      tip: "Swept fees still arrive at its address. It needs one activation before the holder can withdraw." });
    assert.equal(row(html, "Withdrawal lock").value, '<dd class="sans">Off</dd>');
    assert.match(row(html, "Withdrawal lock").tip!, /^While on, the treasury cannot send anything/);
    const ids = [...html.matchAll(/role="tooltip" id="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, "each tip has its own id");
    for (const id of ids) assert(html.includes(`aria-describedby="${id}"`), "each tip describes its button");
  } finally { visitor.unmount(); }
  const failed = await card({ owner: () => { throw new Error("RPC down"); } });
  try { assert.equal(row(failed.html(), "Collection").value, '<dd class="sans">0x13Ea…9836</dd>', "a failed read shows the short contract address"); }
  finally { failed.unmount(); }
});

test("the holder's own wallet is marked, a burned NFT has no holder and a failed read says so", async () => {
  const mine = await card({ account: holder });
  try {
    assert.match(row(mine.html(), "Current holder").value, /↗<\/a><span class="sans"> \(you\)<\/span>/);
    assert.equal(row(mine.html(), "Collection").value, '<dd class="sans">MUSEGOD Muses</dd>', "a wallet viewer also reads the collection's name");
  } finally { mine.unmount(); }
  const burned = await card({ owner: () => null });
  try {
    assert.equal(row(burned.html(), "Current holder").value, "<dd>None</dd>");
    assert.match(burned.html(), /This NFT has no holder, so its treasury cannot be used/);
  } finally { burned.unmount(); }
  const failed = await card({ owner: () => { throw new Error("RPC down"); } });
  try { assert.equal(row(failed.html(), "Current holder").value, "<dd>Unavailable</dd>"); } finally { failed.unmount(); }
});

test("a wallet change reads the holder again, so a disconnect never shows the holder from before a sale", async () => {
  let current = holder;
  const buyer = getAddress("0x8888888888888888888888888888888888888888");
  const view = await card({ owner: () => current });
  try {
    assert.match(row(view.html(), "Current holder").value, new RegExp(holder));
    current = buyer;
    await view.setAccount(buyer);
    assert.match(row(view.html(), "Current holder").value, new RegExp(`${buyer}.*\\(you\\)`), "the buyer's wallet reads its own holder check");
    await view.setAccount(null);
    assert.match(row(view.html(), "Current holder").value, new RegExp(buyer), "after a disconnect the visitor sees the current holder");
    assert.equal(view.publicReads(), 3, "one public read per wallet state");
  } finally { view.unmount(); }
});

test("a visitor of an activated treasury is told only the holder can withdraw, not that the holder is still being checked", async () => {
  const visitor = await card({ initialized: true });
  try {
    const html = visitor.html();
    assert.match(html, /Only the NFT holder can withdraw or lock the treasury\./);
    assert.doesNotMatch(html, /Checking the NFT holder/);
    assert.deepEqual(row(html, "Treasury status"), { value: '<dd class="sans">Active</dd>', tip: null, button: null }, "an active treasury needs no tip");
    assert.equal(row(html, "Withdrawal lock").value, '<dd class="sans">Off</dd>');
  } finally { visitor.unmount(); }
  const waiting = await card({ account: "0x7777777777777777777777777777777777777777", initialized: true, status: () => new Promise(() => {}) });
  try { assert.match(waiting.html(), /Checking the NFT holder…/, "a connected wallet still waits for its own holder check"); } finally { waiting.unmount(); }
});
