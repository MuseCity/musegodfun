import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeConfig, TokenRecord } from "../src/lib/config";
import { MUSEGOD } from "../src/lib/musegod";
import { MUSES } from "../src/lib/nft-mode";
import { EMPTY_PROFILE_LINKS } from "../src/lib/token-profile";
import { syntheticToken } from "./fixtures";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

/** Depth-first search of a React element tree for the first element matching `match`. Nested components stay unexpanded. */
function find(node: any, match: (element: any) => boolean): any {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return null; }
  if (match(node)) return node;
  return find(node.props?.children, match);
}

const creator = "0x2222222222222222222222222222222222222222";
const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: true, blockReason: null, fomoInvite: "musegod", nftMode: { enabled: true, vaultFactory: null, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } };
const coin = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, quoteAddress: MUSEGOD.weth, creator, tradingFeeBps: 100,
  feePolicy: "creator-70-musegod-v2", twitter: "https://x.com/musegod_rh", description: "A coin about cakes." });
const muse = { ...coin, nft: { chainId: 4663, contract: MUSES.contract, tokenId: "931" } } as TokenRecord;
const market = { summary: { data: null, loading: false, error: "" }, trades: { data: null, loading: false, error: "" }, stats: null, tradeData: null,
  currentLive: null, liveNode: null, refresh() {} };

let TokenDetail: any, account: string | null = null;
const render = (detail: Record<string, unknown>, runtime: RuntimeConfig | null = config) =>
  renderToStaticMarkup(createElement(TokenDetail, { detail: { state: { poolKey: {} }, ...detail }, config: runtime, refreshError: "" }));

test.before(async () => {
  for (const [name, value] of Object.entries({ localStorage: { getItem: () => null, setItem() {} }, location: { origin: "https://musegod.fun" },
    __BUILD_IDENTITY__: { schemaVersion: 1, repository: "https://github.com/test/test", commit: "a".repeat(40), source: "local", dirty: true, buildId: null, runUrl: null, releaseUrl: null } }))
    if (!(name in globalThis)) Object.defineProperty(globalThis, name, { configurable: true, value });
  ({ TokenDetail } = await importFresh("src/App.tsx", {
    "./lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => ({ account }) } },
    "./lib/resource": { file: import.meta.resolve("../src/lib/resource.ts"), bindings: { useResource: () => ({ data: null, error: "", loading: false }) } },
    "./components/TokenMarket": { file: import.meta.resolve("../src/components/TokenMarket.tsx"), bindings: { useLaunchMarket: () => market } },
    "./lib/nft-client": { file: import.meta.resolve("../src/lib/nft-client.ts"), bindings: { readNftStatus: async () => ({ controls: true }) } },
  }, ["TokenDetail"]));
});
test.afterEach(() => { account = null; });

test("a visitor sees the coin as an IP: socials first, Doppler and the owner's Fomo invite for trading, no in-page swap", () => {
  const html = render({ token: coin });
  assert.match(html, /Robinhood Chain · WETH pair · launched/);
  assert(html.includes(`href="https://app.doppler.lol/tokens/robinhood/${coin.address.toLowerCase()}"`));
  assert.match(html, />Trade on Doppler/);
  assert.match(html, /href="https:\/\/fomo\.family\/r\/musegod"[^>]*>Open Fomo with invite/);
  assert.match(html, /href="https:\/\/x\.com\/musegod_rh"/);
  assert.match(html, /Channels · 1 linked/);
  assert.match(html, /role="tab"[^>]*>Overview<.*role="tab"[^>]*>Activity<.*role="tab"[^>]*>On-chain</);
  assert.match(html, /Pool fee on any venue, per \$100/);
  assert.doesNotMatch(html, /Edit profile|Talk to it|not linked|Posts|Pay with ETH|Slippage|OpenSea|Agent identity/);
  assert.doesNotMatch(html, /<input/, "the page has no amount field: trading happens on the venues");
  assert.doesNotMatch(render({ token: coin }, { ...config, fomoInvite: null }), /fomo\.family/, "Fomo shows only with the owner's invite handle");
});

test("the creator's wallet gets Edit profile; a saved profile replaces the launch links and names its signer", () => {
  account = creator;
  assert.match(render({ token: coin }), /Edit profile/);
  account = "0x3333333333333333333333333333333333333333";
  assert.doesNotMatch(render({ token: coin }), /Edit profile/);
  const profile = { links: { ...EMPTY_PROFILE_LINKS, youtube: "https://youtube.com/@cakes", tiktok: "https://tiktok.com/@cakes" }, signer: creator, issuedAt: 1, savedAt: 1 };
  const html = render({ token: coin, profile });
  assert.match(html, /href="https:\/\/youtube\.com\/@cakes"/);
  assert.match(html, /href="https:\/\/tiktok\.com\/@cakes"/);
  assert.doesNotMatch(html, /x\.com\/musegod_rh/, "the owner removed X");
  assert.match(html, /Channels · 2 linked/);
  assert.match(html, /Saved by 0x2222…2222/);
});

test("an owner with no links gets a prompt; a visitor sees no empty channels card", () => {
  const bare = { ...coin, twitter: undefined };
  assert.doesNotMatch(render({ token: bare }), /Channels/, "no zero-count stat and no empty card");
  account = creator;
  assert.match(render({ token: bare }), /Link X, YouTube, TikTok, Telegram or a website/);
});

test("an NFT-bound agent coin names its Muse, links OpenSea, shows the ERC-8004 identity and leaves editing to the holder", () => {
  account = creator;
  const html = render({ token: muse, nftProfile: { name: "Jubilee", agentId: "42" } });
  assert.match(html, /Muse #931 · Jubilee · Robinhood Chain/);
  assert(html.includes(`href="https://opensea.io/item/robinhood/${MUSES.contract.toLowerCase()}/931"`));
  assert.match(html, /ERC-8004 agent #42/);
  assert.match(html, /Agent identity · ERC-8004/);
  assert.match(html, /NFT treasury share/);
  assert.doesNotMatch(html, /Edit profile/, "the launcher of an NFT coin is not its owner until the holder check passes");
  assert.doesNotMatch(render({ token: muse }), /Agent identity|ERC-8004 agent/, "no agent id, no agent card");
});

test("fork coins and pools that fail the on-chain check never link to a mainnet venue", () => {
  const fork = render({ token: { ...coin, mode: "fork" } }, { ...config, mode: "fork" });
  assert.doesNotMatch(fork, /app\.doppler\.lol|Trade on Doppler/);
  assert.match(fork, /Local fork coins trade on the fork only/);
  const invalid = render({ token: coin, stateInvalid: true });
  assert.match(invalid, /trading links are hidden/);
  assert.doesNotMatch(invalid, /Trade on Doppler|fomo\.family|Liquidity locked/);
});

test("an NFT holder gets Edit profile even when the runtime config loads after the wallet and the coin", async () => {
  const holder = "0x5555555555555555555555555555555555555555";
  const statusCalls: unknown[][] = [];
  let StatefulDetail: any;
  const props: any = { detail: { token: muse, state: { poolKey: {} } }, config: null, refreshError: "" };
  const runtime = hookRuntime(() => StatefulDetail(props));
  account = holder;
  ({ TokenDetail: StatefulDetail } = await importFresh("src/App.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "./lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => ({ account }) } },
    "./lib/resource": { file: import.meta.resolve("../src/lib/resource.ts"), bindings: { useResource: () => ({ data: null, error: "", loading: false }) } },
    "./components/TokenMarket": { file: import.meta.resolve("../src/components/TokenMarket.tsx"), bindings: { useLaunchMarket: () => market } },
    "./lib/nft-client": { file: import.meta.resolve("../src/lib/nft-client.ts"), bindings: { readNftStatus: async (...args: unknown[]) => { statusCalls.push(args); return { controls: true }; } } },
  }, ["TokenDetail"]));
  const TokenHero = (await import("../src/components/TokenHero")).default;
  const hero = () => find(runtime.output(), (element) => element.type === TokenHero);
  try {
    runtime.render(); await settle();
    assert.equal(statusCalls.length, 0, "no config yet: nothing to read with");
    assert.equal(hero().props.onEdit, undefined);
    props.config = config; runtime.render(); await settle(); await settle();
    assert.equal(statusCalls.length, 1, "the config's arrival runs the holder check");
    assert.equal(typeof hero().props.onEdit, "function", "the holder can edit");
  } finally { runtime.unmount(); }
});

test("the trade card offers the pool quote whenever no price is indexed, and still shows the metrics it has", async () => {
  const { default: TokenVenues } = await import("../src/components/TokenVenues");
  const { quoteAsset } = await import("../src/lib/config");
  const summary = { fetchedAt: "2026-10-17T00:00:00.000Z", status: "fresh", source: "CoinGecko", priceUsd: null, fdvUsd: null, marketCapUsd: null,
    liquidityUsd: null, periods: { h24: { change: null, volume: 0, buys: 0, sells: 0 } } };
  const html = renderToStaticMarkup(createElement(TokenVenues, { token: coin, stock: quoteAsset(coin), fomoHandle: null, quoteProbe: async () => ({ amountOut: "1" }),
    market: { ...market, summary: { data: summary, loading: false, error: "" }, stats: summary } as any }));
  assert.match(html, /Get pool quote/);
  assert.match(html, /24h volume/, "a real zero volume still shows");
  assert.doesNotMatch(html, /class="market-price"/, "no price line without a price");
});

test("Activity scopes an empty list to the index and never claims there were no trades", async () => {
  const { default: TokenActivity } = await import("../src/components/TokenActivity");
  const empty = (extra: object) => renderToStaticMarkup(createElement(TokenActivity, { token: coin, market: { ...market,
    trades: { data: { fetchedAt: "2026-10-17T00:00:00.000Z", status: "fresh", trades: [], ...extra }, loading: false, error: "" },
    tradeData: { fetchedAt: "2026-10-17T00:00:00.000Z", status: "fresh", trades: [], ...extra } } as any }));
  assert.match(empty({}), /No indexed trades in this snapshot\./);
  assert.match(empty({ reason: "not_indexed" }), /Market records are not indexed for this pool yet\./);
  for (const html of [empty({}), empty({ reason: "not_indexed" })]) assert.doesNotMatch(html, /No trades yet|seconds after/);
});

const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object"
  ? [node, ...nodes(node.props?.children)] : [];
const textOf = (node: any): string => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
const button = (tree: any, label: string) => find(tree, (element) => element.type === "button" && textOf(element) === label);

async function detailRuntime(options: { token?: TokenRecord; runtime?: RuntimeConfig | null; status?: (...args: any[]) => Promise<any>; wallet?: any } = {}) {
  let View: any;
  const props = { detail: { token: options.token ?? coin, state: { poolKey: {} } }, config: options.runtime === undefined ? config : options.runtime, refreshError: "" };
  const runtime = hookRuntime(() => View(props));
  ({ TokenDetail: View } = await importFresh("src/App.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "./lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => options.wallet ?? { account } } },
    "./lib/resource": { file: import.meta.resolve("../src/lib/resource.ts"), bindings: { useResource: () => ({ data: null, error: "", loading: false }) } },
    "./components/TokenMarket": { file: import.meta.resolve("../src/components/TokenMarket.tsx"), bindings: { useLaunchMarket: () => market } },
    "./lib/nft-client": { file: import.meta.resolve("../src/lib/nft-client.ts"), bindings: { readNftStatus: options.status ?? (async () => ({ controls: true })) } },
  }, ["TokenDetail"]));
  return { ...runtime, props };
}

test("hidden NFT coins warn on Overview; unverified opening targets and empty descriptions stay honest", () => {
  const hidden = render({ token: { ...muse, hidden: true } });
  assert.match(hidden, /Hidden by operator/);
  assert.match(hidden, /id="token-tab-overview"[^>]*aria-selected="true"/);
  const unverified = render({ token: { ...coin, openingValuation: {} as any, openingValuationUnverified: true, description: "" } });
  assert.match(unverified, /Opening valuation.*unverified target/);
  assert.doesNotMatch(unverified, /has not added a description|class="body-copy"/);
});

test("the venues disclose only the added frontend fee and verified Fomo claim, without live-announcing prices", () => {
  const html = render({ token: coin });
  assert.match(html, /musegod.fun adds no fee of its own and signs nothing here/);
  assert.match(html, /Fomo adds its own app fee/);
  assert.doesNotMatch(html, /takes no trading fee|Apple Pay|gasless|class="venue-price" aria-live/);
});

test("an unverified NFT collection keeps its contract hint in the hero; long website labels have an ellipsis container", () => {
  const html = render({ token: { ...muse, nft: { ...muse.nft!, contract: "0x9999999999999999999999999999999999999999" },
    website: `https://example.org/${"long".repeat(40)}` } });
  assert.match(html, /NFT · unverified collection · 0x9999…9999/);
  assert.match(html, /class="secondary small-button" href="https:\/\/example.org\/[^\"]+"[^>]*><span>example.org\/[^<]+<\/span>/);
});

test("NFT mode off skips owner reads and closes editing; enabling it retries one failure and recognizes a delegate", async () => {
  account = creator;
  let reads = 0;
  const runtime = await detailRuntime({ token: muse, runtime: { ...config, nftMode: { ...config.nftMode!, enabled: false } },
    status: async () => { if (++reads === 1) throw new Error("Temporary status failure"); return { controls: true, owner: "0x5555555555555555555555555555555555555555" }; } });
  const hero = () => find(runtime.output(), (node) => node.type?.name === "TokenHero");
  try {
    runtime.render(); await settle(); assert.equal(reads, 0); assert.equal(hero().props.onEdit, undefined);
    runtime.props.config = config; runtime.render(); await settle();
    assert.equal(reads, 2); assert.equal(typeof hero().props.onEdit, "function", "a delegate controls editing too");
    hero().props.onEdit(); await settle();
    assert(find(runtime.output(), (node) => node.type?.name === "ProfileEditor"));
    runtime.props.config = { ...config, nftMode: { ...config.nftMode!, enabled: false } }; runtime.render(); await settle();
    assert.equal(hero().props.onEdit, undefined); assert.equal(find(runtime.output(), (node) => node.type?.name === "ProfileEditor"), null);
  } finally { runtime.unmount(); }
});

test("two failed owner reads grant no edit; switching accounts discards a late holder answer", async () => {
  account = creator;
  let reads = 0, finish: (value: any) => void = () => {};
  const runtime = await detailRuntime({ token: muse, status: async () => {
    reads++; if (reads <= 2) throw new Error("Status unavailable");
    if (reads === 3) return new Promise((resolve) => { finish = resolve; });
    return { controls: false };
  } });
  const hero = () => find(runtime.output(), (node) => node.type?.name === "TokenHero");
  try {
    runtime.render(); await settle(); assert.equal(reads, 2); assert.equal(hero().props.onEdit, undefined);
    account = "0x5555555555555555555555555555555555555555"; runtime.render(); await settle();
    account = "0x6666666666666666666666666666666666666666"; runtime.render(); await settle();
    finish({ controls: true }); await settle(); assert.equal(hero().props.onEdit, undefined);
  } finally { runtime.unmount(); }
});

test("wallet ownership changes close the editor, and onSaved updates the page's links", async () => {
  account = creator;
  const runtime = await detailRuntime();
  const editor = () => find(runtime.output(), (node) => node.type?.name === "ProfileEditor");
  const hero = () => find(runtime.output(), (node) => node.type?.name === "TokenHero");
  try {
    runtime.render(); hero().props.onEdit(); await settle();
    editor().props.onSaved({ links: { ...EMPTY_PROFILE_LINKS, youtube: "https://youtube.com/@cakes" }, signer: creator, issuedAt: 1, savedAt: 1 });
    await settle(); assert.deepEqual(hero().props.links.map((link: any) => link.field), ["youtube"]);
    account = "0x5555555555555555555555555555555555555555"; runtime.render(); await settle(); assert.equal(editor(), null);
    account = creator; runtime.render(); await settle(); assert.equal(editor(), null, "ownership recovery does not reopen an old editor");
  } finally { runtime.unmount(); }
});

test("tabs support keyboard wrapping and beneficiary navigation focuses and scrolls On-chain", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), focused: string[] = [], scrolled: string[] = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { getElementById: (id: string) => ({ focus: () => focused.push(id), scrollIntoView: () => scrolled.push(id) }) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); });
  const runtime = await detailRuntime();
  const tab = (name: string) => find(runtime.output(), (node) => node.props?.id === `token-tab-${name}`);
  try {
    runtime.render(); let prevented = false;
    tab("overview").props.onKeyDown({ key: "ArrowLeft", preventDefault: () => { prevented = true; } }); await settle();
    assert(prevented); assert.equal(tab("onchain").props["aria-selected"], true); assert.deepEqual(focused, ["token-tab-onchain"]);
    tab("onchain").props.onKeyDown({ key: "ArrowRight", preventDefault() {} }); await settle(); assert.equal(tab("overview").props.tabIndex, 0);
    button(runtime.output(), "On-chain details").props.onClick(); await settle();
    assert.equal(tab("onchain").props["aria-selected"], true); assert.deepEqual(scrolled, ["token-tab-onchain"]);
  } finally { runtime.unmount(); }
});

test("visited panels retain an actual claim's hash and error and Activity choices while hidden", async () => {
  account = creator;
  let rejectClaim: (error: Error) => void = () => {};
  const hash = `0x${"ab".repeat(32)}`;
  const wallet = { account, chainId: 4663, revision: 0, send: async (_to: any, _data: any, _config: any, onHash: any) => {
    onHash(hash); return new Promise((_resolve, reject) => { rejectClaim = reject; });
  } };
  const parent = await detailRuntime({ wallet });
  const feeNode = () => find(parent.output(), (node) => node.type?.name === "FeeCard");
  const activityNode = () => find(parent.output(), (node) => node.type?.name === "TokenActivity");
  let Fee: any, Activity: any;
  const fee = hookRuntime(() => Fee(feeNode().props));
  const activity = hookRuntime(() => Activity({ ...activityNode().props, market: { ...market,
    stats: { periods: { h24: { buys: 1 }, h1: { buys: 2 } } }, tradeData: { trades: [{ id: "a", side: "buy", amount: 1, at: new Date().toISOString(), hash }] } } }));
  ({ FeeCard: Fee } = await importFresh("src/App.tsx", {
    react: { file: import.meta.resolve("react"), bindings: fee.hooks },
    "./lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => wallet } },
    "./lib/api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async () => ({ trade: { fees0: "1", fees1: "0" }, lp: { fees0: "0", fees1: "0" }, poolKey: { currency0: coin.address, currency1: MUSEGOD.weth } }) } },
  }));
  ({ default: Activity } = await importFresh("src/components/TokenActivity.tsx", { react: { file: import.meta.resolve("react"), bindings: activity.hooks } }));
  const select = async (id: string) => { find(parent.output(), (node) => node.props?.id === `token-tab-${id}`).props.onClick(); await settle(); };
  try {
    parent.render(); assert.equal(feeNode(), null); assert.equal(activityNode(), null, "no reads before the first visit");
    await select("onchain"); const feeType = feeNode().type; fee.render(); button(fee.output(), "Check fees").props.onClick(); await settle();
    assert.equal(button(fee.output(), "Claim trading fee").props.disabled, false);
    button(fee.output(), "Claim trading fee").props.onClick(); await settle();
    assert.equal(button(fee.output(), "Claim trading fee").props.disabled, true);
    await select("activity"); assert.equal(feeNode().type, feeType, "the same component stays mounted");
    assert.equal(find(parent.output(), (node) => node.props?.id === "token-panel-onchain").props.hidden, true);
    activity.render(); button(activity.output(), "1h").props.onClick(); button(activity.output(), "Sell").props.onClick(); await settle();
    rejectClaim(new Error("Claim failed after wallet confirmation")); await settle();
    await select("onchain"); fee.render();
    assert(nodes(fee.output()).some((node) => node.props?.hash === hash));
    assert.match(textOf(fee.output()), /Claim failed after wallet confirmation/);
    await select("activity"); activity.render();
    assert.equal(button(activity.output(), "1h").props["aria-pressed"], true); assert.equal(button(activity.output(), "Sell").props["aria-pressed"], true);
  } finally { parent.unmount(); fee.unmount(); activity.unmount(); }
});

test("a non-fork pool quote is gated by state, shows its average fill price, and exposes read errors", async () => {
  const { quoteAsset } = await import("../src/lib/config");
  const baseProps = { token: coin, stock: quoteAsset(coin), market, fomoHandle: null, quoteProbe: async () => ({ amountOut: (2n * 10n ** 18n).toString() }) };
  const { default: RealVenues } = await import("../src/components/TokenVenues");
  assert.doesNotMatch(renderToStaticMarkup(createElement(RealVenues, { ...baseProps, stateUnavailable: true })), /Get pool quote/);
  let View: any, fail = false;
  const runtime = hookRuntime(() => View({ ...baseProps, quoteProbe: async () => { if (fail) throw new Error("Pool read failed"); return baseProps.quoteProbe(); } }));
  ({ default: View } = await importFresh("src/components/TokenVenues.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } }));
  try {
    runtime.render(); fail = true; button(runtime.output(), "Get pool quote").props.onClick(); await settle();
    assert.match(textOf(runtime.output()), /Pool read failed/);
    fail = false; button(runtime.output(), "Get pool quote").props.onClick(); await settle();
    assert.match(textOf(runtime.output()), /Average price: ≈ 0.5 WETH per .*average for a 1-unit buy with 1 WETH, fees included/);
    assert.match(textOf(find(runtime.output(), (element) => element.props?.role === "status" && /Average price/.test(textOf(element)))), /Average price/,
      "the result lands in a status region that was already mounted");
    assert.doesNotMatch(textOf(runtime.output()), /Pool read failed/);
  } finally { runtime.unmount(); }
});

test("a coin with neither a description nor a recorded fee policy shows no empty About card", () => {
  assert.doesNotMatch(render({ token: { ...coin, description: "", feePolicy: undefined } }), /About Synthetic Meme/);
  assert.match(render({ token: { ...coin, description: "" } }), /About Synthetic Meme/, "the fee owner sentence alone still fills it");
});
