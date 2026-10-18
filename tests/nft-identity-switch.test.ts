import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { RuntimeConfig } from "../src/lib/config";
import { NftLaunchStep } from "../src/components/NftLaunchStep";
import { NftPicker } from "../src/components/NftPicker";
import { launchDraftKey } from "../src/lib/launch-draft";
import { MUSES, type NftStatus } from "../src/lib/nft-mode";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

// The create page and its NFT step, rendered together with the real prefill and draft code: switching the NFT must move every
// NFT-derived identity field (name, symbol, image) to the new NFT, keep what the person typed, and never show the old NFT's values.

function find(node: any, match: (element: any) => boolean): any {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return null; }
  if (match(node)) return node;
  return find(node.props?.children, match);
}
const textOf = (node: any): string => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");

const holder = "0x5555555555555555555555555555555555555555";
const hood = "0x7777777777777777777777777777777777777777";
const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: true, blockReason: null, fomoInvite: "musegod",
  nftMode: { enabled: true, vaultFactory: null, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } };
const wallet = { account: holder, chainId: 4663, connecting: false, restoring: false, revision: 0, error: "",
  connect: async () => {}, switchChain: async () => {}, balance: async () => 0n, balanceNative: async () => 0n };
/** The live check's answers: Muses by their on-chain names, other NFTs by token id. */
const museNames: Record<string, string> = { "1": "Bard", "2": "Cadenza", "3": "Moonlet" };
const pinned = (source: string) => `https://pin.test/${source}`;
const store = new Map<string, string>();

test.before(() => {
  for (const [name, value] of Object.entries({
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); } },
    location: { origin: "https://musegod.fun", pathname: "/create", search: "", hash: "" }, history: { state: null, replaceState() {} }, window: new EventTarget(),
    document: Object.assign(new EventTarget(), { getElementById: () => null, activeElement: null, body: null, visibilityState: "visible" }),
    requestAnimationFrame: (): number => 0,
    // Nothing here may reach a network: every API the page uses is replaced below.
    fetch: async () => { throw new Error("No network in tests"); },
    __BUILD_IDENTITY__: { schemaVersion: 1, repository: "https://github.com/test/test", commit: "a".repeat(40), source: "local", dirty: true, buildId: null, runUrl: null, releaseUrl: null } }))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
});
test.beforeEach(() => store.clear());

/** The create page with its NFT step. `saved`: a draft stored before the page opened. `refuse`: token ids whose live check says no. */
async function launchForm(t: TestContext, options: { saved?: Record<string, unknown>; refuse?: string[] } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  if (options.saved) store.set(launchDraftKey(config), JSON.stringify(options.saved));
  let Create: any, Step: any;
  const parent = hookRuntime(() => Create({ stocks: null, stockError: "", config, refresh() {} }));
  const stepProps = () => find(parent.output(), (element) => element.type === NftLaunchStep)?.props;
  const child = hookRuntime(() => Step(stepProps()));
  const status = async (_config: unknown, nft: { contract: string; tokenId: string }): Promise<NftStatus> => {
    const free = nft.contract.toLowerCase() === MUSES.contract.toLowerCase();
    return { erc721: true, controls: !options.refuse?.includes(nft.tokenId), alreadyLaunched: false, free,
      ...(free && museNames[nft.tokenId] ? { name: museNames[nft.tokenId] } : {}) } as NftStatus;
  };
  ({ CreatePage: Create } = await importFresh("src/App.tsx", {
    react: { file: import.meta.resolve("react"), bindings: parent.hooks },
    "./lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => wallet } },
    "./lib/resource": { file: import.meta.resolve("../src/lib/resource.ts"), bindings: { useResource: () => ({ data: null, error: "", loading: false }) } },
    "./lib/api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: {
      chainApi: async (_chain: number, path: string, body: { image: string }) => {
        if (path === "/token-images") return { image: pinned(body.image) };
        throw new Error(`Unexpected API call ${path}`);
      } } },
    "./lib/image-upload": { file: import.meta.resolve("../src/lib/image-upload.ts"), bindings: { prepareTokenImageFromUrl: async (url: string) => url } },
  }, ["CreatePage"]));
  ({ NftLaunchStep: Step } = await importFresh("src/components/NftLaunchStep.tsx", {
    react: { file: import.meta.resolve("react"), bindings: child.hooks },
    "../lib/nft-client": { file: import.meta.resolve("../src/lib/nft-client.ts"), bindings: { readNftStatus: status } },
    "../lib/use-launch-fee": { file: import.meta.resolve("../src/lib/use-launch-fee.ts"), bindings: { useLaunchFee: () => ({ state: "none", record: null }) } },
  }));
  /** React re-renders the step with the page; here both render until nothing changes. */
  const flush = async () => { for (let i = 0; i < 8; i++) { await settle(); parent.render(); if (stepProps()) child.render(); } };
  const input = (name: string) => find(parent.output(), (element) => element.type === "input" && element.props.name === name);
  const form = {
    /** The identity fields as the Identity step shows them. */
    fields: () => ({ name: input("name").props.value, symbol: input("symbol").props.value, image: input("image").props.value }),
    /** Whether the Identity step says the image is the NFT's. */
    nftImageNotice: () => !!find(parent.output(), (element) => element.props?.id === "token-image-nft"),
    type: async (name: string, value: string) => { input(name).props.onChange({ target: { value } }); await flush(); },
    /** Picks an NFT from the wallet list, opening the list first when an NFT is already chosen. */
    async pick(contract: string, tokenId: string, name?: string) {
      const change = find(child.output(), (element) => element.type === "button" && textOf(element) === "Change");
      if (change) { change.props.onClick(); await flush(); }
      find(child.output(), (element) => element.type === NftPicker).props.onPick({ contract, tokenId, name, image: `https://img.test/${tokenId}` });
      await flush();
    },
    /** Lets the step's live check (400 ms after the last change) run and answer. */
    async check() { t.mock.timers.tick(400); await flush(); },
    async nftMode(next: boolean) {
      find(parent.output(), (element) => typeof element.props?.onChange === "function" && "nftMode" in element.props).props.onChange(next);
      await flush();
    },
    /** The draft as the autosave (250 ms after the last change) stores it. */
    async saved() { t.mock.timers.tick(250); await flush(); return JSON.parse(store.get(launchDraftKey(config)) ?? "null"); },
  };
  t.after(() => { child.unmount(); parent.unmount(); });
  parent.render(); await flush();
  return form;
}
const muse = (tokenId: string) => [MUSES.contract, tokenId] as const;

test("switching the NFT moves name, symbol and image to the new NFT", async (t) => {
  const form = await launchForm(t);
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image: pinned("https://img.test/1") });
  assert.equal(form.nftImageNotice(), true);
  await form.pick(hood, "1202", "The Hood #1202");
  assert.deepEqual(form.fields(), { name: "", symbol: "", image: "" }, "while the new NFT is checked, the old NFT's values are gone");
  await form.check();
  assert.deepEqual(form.fields(), { name: "The Hood #1202", symbol: "THEHOOD", image: pinned("https://img.test/1202") });
  await form.pick(...muse("2"), "Cadenza"); await form.check();
  assert.deepEqual(form.fields(), { name: "Cadenza", symbol: "CADENZA", image: pinned("https://img.test/2") });
  assert.equal(form.nftImageNotice(), true);
});

test("a field the person typed over keeps their value; the fields still holding the NFT's values follow it", async (t) => {
  const form = await launchForm(t);
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  await form.type("name", "Bard the Brave");
  await form.pick(...muse("2"), "Cadenza");
  assert.equal(form.fields().name, "Bard the Brave", "a typed value is never cleared");
  await form.check();
  assert.deepEqual(form.fields(), { name: "Bard the Brave", symbol: "CADENZA", image: pinned("https://img.test/2") });
  await form.type("name", "Cadenza");
  await form.pick(...muse("3"), "Moonlet"); await form.check();
  assert.equal(form.fields().name, "Moonlet", "a value typed back to exactly the NFT's is the NFT's again");
});

test("a draft saved before prefill ownership was recorded follows the next NFT", async (t) => {
  // NFT mode went live on 2026-10-14 with a Muse name prefill that recorded no ownership; such a draft holds the Muse's values only.
  const form = await launchForm(t, { saved: { name: "Bard", symbol: "BARD", description: "", image: "", website: "", twitter: "", telegram: "",
    quoteAddress: "0x0379E228F6887c6F18bf394042ECAF81B308cb2e", tradingFeeBps: 100, nft: { chainId: 4663, contract: MUSES.contract, tokenId: "1" },
    nftMode: true, step: 1 } });
  await form.check();
  assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image: "" }, "the restored NFT's re-check changes nothing");
  await form.pick(...muse("2"), "Cadenza"); await form.check();
  assert.deepEqual(form.fields(), { name: "Cadenza", symbol: "CADENZA", image: pinned("https://img.test/2") });
});

test("a restored draft keeps its recorded prefill, which follows the next NFT", async (t) => {
  const image = pinned("https://img.test/1");
  const form = await launchForm(t, { saved: { name: "Bard", symbol: "BARD", description: "", image, website: "", twitter: "", telegram: "",
    quoteAddress: "0x0379E228F6887c6F18bf394042ECAF81B308cb2e", tradingFeeBps: 100, nft: { chainId: 4663, contract: MUSES.contract, tokenId: "1" },
    nftMode: true, step: 1, nftPrefill: { name: "Bard", symbol: "BARD", image } } });
  await form.check();
  assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image });
  assert.equal(form.nftImageNotice(), true);
  await form.pick(...muse("2"), "Cadenza"); await form.check();
  assert.deepEqual(form.fields(), { name: "Cadenza", symbol: "CADENZA", image: pinned("https://img.test/2") });
  assert.deepEqual((await form.saved()).nftPrefill, form.fields(), "the autosave records the new NFT's prefill");
});

test("an NFT whose check says no leaves no values of the previous NFT behind", async (t) => {
  const form = await launchForm(t, { refuse: ["9"] });
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  await form.pick(hood, "9", "Not Mine #9"); await form.check();
  assert.deepEqual(form.fields(), { name: "", symbol: "", image: "" });
  assert.equal(form.nftImageNotice(), false);
});

test("a restored NFT the check drops keeps its values until the person picks another NFT, which clears them", async (t) => {
  const image = pinned("https://img.test/1");
  const form = await launchForm(t, { refuse: ["1", "9"], saved: { name: "Bard", symbol: "BARD", description: "", image, website: "", twitter: "",
    telegram: "", quoteAddress: "0x0379E228F6887c6F18bf394042ECAF81B308cb2e", tradingFeeBps: 100, nft: { chainId: 4663, contract: MUSES.contract, tokenId: "1" },
    nftMode: true, step: 1, nftPrefill: { name: "Bard", symbol: "BARD", image } } });
  await form.check();
  assert.deepEqual(form.fields(), { name: "Bard", symbol: "BARD", image }, "an automatic drop is not the person's change");
  await form.pick(hood, "9", "Not Mine #9");
  assert.deepEqual(form.fields(), { name: "", symbol: "", image: "" });
  await form.check();
  assert.deepEqual(form.fields(), { name: "", symbol: "", image: "" });
});

test("leaving NFT mode clears the NFT's values instead of presenting them as the coin's own", async (t) => {
  const form = await launchForm(t);
  await form.nftMode(true);
  await form.pick(...muse("1"), "Bard"); await form.check();
  await form.type("symbol", "MINE");
  await form.nftMode(false);
  assert.deepEqual(form.fields(), { name: "", symbol: "MINE", image: "" });
  assert.equal(form.nftImageNotice(), false);
});
