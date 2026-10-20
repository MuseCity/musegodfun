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

let TokenDetail: any, account: string | null = null, resources: Record<string, unknown> = {};
const render = (detail: Record<string, unknown>, runtime: RuntimeConfig | null = config) =>
  renderToStaticMarkup(createElement(TokenDetail, { detail: { state: { poolKey: {} }, ...detail }, config: runtime, refreshError: "" }));

test.before(async () => {
  for (const [name, value] of Object.entries({ localStorage: { getItem: () => null, setItem() {} },
    location: { origin: "https://musegod.fun", pathname: "/", search: "", hash: "" }, history: { state: null, replaceState() {} }, window: new EventTarget(),
    __BUILD_IDENTITY__: { schemaVersion: 1, repository: "https://github.com/test/test", commit: "a".repeat(40), source: "local", dirty: true, buildId: null, runUrl: null, releaseUrl: null } }))
    if (!(name in globalThis)) Object.defineProperty(globalThis, name, { configurable: true, value });
  ({ TokenDetail } = await importFresh("src/App.tsx", {
    "./lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => ({ account }) } },
    "./lib/resource": { file: import.meta.resolve("../src/lib/resource.ts"), bindings: { useResource: (path: string) => ({ data: resources[path] ?? null, error: "", loading: false }) } },
    "./components/TokenMarket": { file: import.meta.resolve("../src/components/TokenMarket.tsx"), bindings: { useLaunchMarket: () => market } },
    "./lib/nft-client": { file: import.meta.resolve("../src/lib/nft-client.ts"), bindings: { readNftStatus: async () => ({ controls: true }) } },
  }, ["TokenDetail"]));
});
test.afterEach(() => { account = null; resources = {}; });

test("a visitor sees the coin as an IP: socials first, Doppler and the owner's Fomo invite for trading, no in-page swap", () => {
  const html = render({ token: coin });
  const hero = html.slice(0, html.indexOf("</header>"));
  assert(hero.includes(`<div class="token-hero-identity"><div class="token-hero-contract"><span class="token-hero-address" title="${coin.address}"><span>${coin.address.slice(0, -4)}</span><span>${coin.address.slice(-4)}</span></span><button type="button" class="hero-copy" aria-label="Copy contract address">`),
    "the hero's first line is the coin's contract address with its copy button");
  assert.doesNotMatch(hero, /Robinhood Chain|WETH pair/, "no chain or pair line: the pair badge is the hero's only mention of the pair");
  assert.match(hero, /<div class="token-hero-meta"><span>by <a class="mono"[^>]*>0x2222…2222<\/a><\/span><span>launched <span class="mono strong">/,
    "the creator has no copy button, and the launch date moved to the meta line");
  assert(html.includes(`href="https://app.doppler.lol/tokens/robinhood/${coin.address.toLowerCase()}"`));
  assert.match(html, />Trade on Doppler/);
  assert.match(html, /href="https:\/\/fomo\.family\/r\/musegod"[^>]*>Open Fomo with invite/);
  assert.match(html, /href="https:\/\/x\.com\/musegod_rh"/);
  assert.match(html, /Channels · 1 linked/);
  assert.match(html, /role="tab"[^>]*>Overview<.*role="tab"[^>]*>Activity<.*role="tab"[^>]*>On-chain</);
  assert.match(html, /Pool fee on any venue, per \$100/);
  assert.match(html, /<span class="eyebrow muted">Creator fee<\/span><span class="mono">0.665%<\/span><span class="hint">of every trade · fixed at launch<\/span>/,
    "the headline is the creator fee per trade (1% trading fee × 66.5% creator share)");
  assert.doesNotMatch(html, /Buyback share/, "the buyback share is a fee detail, not a headline fact");
  assert.doesNotMatch(html, /Edit profile|Talk to it|not linked|Pay with ETH|Slippage|OpenSea|Agent identity/);
  assert.match(html, /role="tab"[^>]*>Posts</);
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
  assert(html.includes(`<div class="token-hero-contract"><span class="token-hero-address" title="${muse.address}">`), "an NFT coin's first line is its contract too");
  assert.doesNotMatch(html.slice(0, html.indexOf("</header>")), /Jubilee|Robinhood Chain/);
  assert.match(html, /Whoever holds Muse #931 · Jubilee controls its treasury/, "the Muse's name stays in About");
  assert(html.includes(`href="https://opensea.io/item/robinhood/${MUSES.contract.toLowerCase()}/931"`));
  assert.doesNotMatch(html, /ERC-8004 agent #42/, "the agent id is not a hero badge");
  assert.match(html, /Agent identity · ERC-8004/);
  assert.match(html, /<dt>Agent ID<\/dt><dd>#42<\/dd>/, "the Agent identity card keeps the id");
  assert.match(html, /<span class="eyebrow muted">Creator fee<\/span><span class="mono">0.665%<\/span><span class="hint">of every trade · to the NFT treasury · fixed at launch<\/span>/);
  assert.doesNotMatch(html, /Edit profile/, "the launcher of an NFT coin is not its owner until the holder check passes");
  assert.doesNotMatch(render({ token: muse }), /Agent identity|ERC-8004 agent/, "no agent id, no agent card");
});

test("the pair badge reads \"Paired with <symbol>\": green with a check once verified, plain while loading, unverified or invalid", () => {
  const verified = /<span class="chip sm up" title="Verified quote asset: Wrapped Ether \(WETH\)"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Paired with WETH<\/span>/;
  const plain = /<span class="chip sm sunken" title="Quote asset: Wrapped Ether \(WETH\)">Paired with WETH<\/span>/;
  const check = (html: string, expected: RegExp, why: string) => {
    assert.match(html, expected, why);
    assert.doesNotMatch(html.replace(/title="[^"]*"/g, ""), /Verified quote asset|visually-hidden">Verified/, "the claim lives in the title, never in the badge text");
  };
  check(render({ token: coin }), plain, "before the status loads");
  resources = { "/stocks": [{ address: MUSEGOD.weth, verified: true }] };
  check(render({ token: coin }), verified, "a verified quote asset");
  check(render({ token: coin, stateInvalid: true }), plain, "a pool that fails the on-chain check gets no check mark");
  check(render({ token: muse }), verified, "an NFT coin too, whose meta keeps only the launch date");
  resources = { "/stocks": [{ address: MUSEGOD.weth, verified: false }] };
  check(render({ token: coin }), plain, "an unverified quote asset");
});

test("the hero contract line copies the address, confirms for two seconds and reports a refused clipboard", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => { if (previous) Object.defineProperty(globalThis, "navigator", previous); else Reflect.deleteProperty(globalThis, "navigator"); });
  const writes: string[] = [];
  let clipboard: any = { writeText: async (text: string) => { writes.push(text); } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ clipboard }) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let View: any;
  const runtime = hookRuntime(() => View({ address: coin.address }));
  ({ HeroContract: View } = await importFresh("src/components/TokenHero.tsx",
    { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } }));
  const copy = () => find(runtime.output(), (node) => node.type === "button" && node.props.className === "hero-copy");
  const alert = () => find(runtime.output(), (node) => node.props?.role === "alert");
  try {
    runtime.render();
    assert.equal(copy().props["aria-label"], "Copy contract address");
    copy().props.onClick(); await settle(); await settle();
    assert.deepEqual(writes, [coin.address]);
    assert.equal(copy().props["aria-label"], "Contract address copied");
    t.mock.timers.tick(2000); await settle();
    assert.equal(copy().props["aria-label"], "Copy contract address", "the confirmation clears after two seconds");
    clipboard = { writeText: async () => { throw new Error("denied"); } };
    copy().props.onClick(); await settle(); await settle();
    assert.equal(textOf(alert()), "Copy failed. Select the address and copy it manually.");
    clipboard = undefined;
    copy().props.onClick(); await settle(); await settle();
    assert(alert(), "a page without the Clipboard API reports the failure instead of throwing");
  } finally { runtime.unmount(); }
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

async function detailRuntime(options: { token?: TokenRecord; runtime?: RuntimeConfig | null; status?: (...args: any[]) => Promise<any>; wallet?: any; postHolder?: () => Promise<string> } = {}) {
  let View: any;
  const props = { detail: { token: options.token ?? coin, state: { poolKey: {} } }, config: options.runtime === undefined ? config : options.runtime, refreshError: "" };
  const runtime = hookRuntime(() => View(props));
  ({ TokenDetail: View } = await importFresh("src/App.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "./lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => options.wallet ?? { account },
      transactionClient: () => ({ getBlockNumber: async () => 1n, readContract: options.postHolder ?? (async () => "0x0000000000000000000000000000000000000000") }) } },
    "./lib/resource": { file: import.meta.resolve("../src/lib/resource.ts"), bindings: { useResource: () => ({ data: null, error: "", loading: false }) } },
    "./components/TokenMarket": { file: import.meta.resolve("../src/components/TokenMarket.tsx"), bindings: { useLaunchMarket: () => market } },
    "./lib/nft-client": { file: import.meta.resolve("../src/lib/nft-client.ts"), bindings: { readNftStatus: options.status ?? (async () => ({ controls: true })) } },
  }, ["TokenDetail"]));
  return { ...runtime, props };
}

const blockedEditorReason = "The saved links cannot be confirmed right now. Close the editor and reopen it once they load again.";
/** Render the real editor with the parent's current props, keeping wallet and HTTP at fixture boundaries. */
async function detailEditorRuntime(parent: Awaited<ReturnType<typeof detailRuntime>>, signProfile = async () => ({ signer: creator, signature: "0x1234" })) {
  let View: any;
  const saved: any[] = [], calls: any[][] = [];
  const editor = () => find(parent.output(), (node) => node.type?.name === "ProfileEditor");
  const runtime = hookRuntime(() => View({ ...editor().props, onSaved(profile: any) { saved.push(profile); editor().props.onSaved(profile); } }));
  ({ default: View } = await importFresh("src/components/ProfileEditor.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => ({ account: creator, chainId: 4663,
      connection: () => ({ chainId: 4663 }), signProfile }) } },
    "../lib/api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async (...args: any[]) => {
      calls.push(args); return { links: args[2].links, signer: creator, issuedAt: args[2].issuedAt, savedAt: args[2].issuedAt };
    } } },
  }));
  return { ...runtime, saved, calls, submit: () => find(runtime.output(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} }) };
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

test("NFT mode off skips launch-control reads and closes profile editing; enabling it retries one failure and recognizes a delegate", async () => {
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

test("Posts management belongs to a normal coin's creator or the NFT's actual holder, never its delegate", async () => {
  const holder = "0x5555555555555555555555555555555555555555";
  for (const [wallet, expectedOwner] of [[creator, true], [holder, false]] as const) {
    account = wallet;
    const runtime = await detailRuntime();
    try {
      runtime.render();
      find(runtime.output(), (node) => node.props?.id === "token-tab-posts").props.onClick(); await settle();
      assert.equal(find(runtime.output(), (node) => node.type?.name === "TokenPosts").props.owner, expectedOwner);
    } finally { runtime.unmount(); }
  }
  account = creator;
  const nft = await detailRuntime({ token: muse, status: async () => ({ controls: true, owner: holder }) });
  try {
    nft.render(); await settle();
    assert.equal(typeof find(nft.output(), (node) => node.type?.name === "TokenHero").props.onEdit, "function", "the delegate retains profile editing");
    find(nft.output(), (node) => node.props?.id === "token-tab-posts").props.onClick(); await settle();
    assert.equal(find(nft.output(), (node) => node.type?.name === "TokenPosts").props.owner, false, "controls=true alone never grants Posts authority");
    account = holder; nft.render(); await settle();
    assert.equal(find(nft.output(), (node) => node.type?.name === "TokenPosts").props.owner, true);
    nft.props.config = { ...config, nftMode: { ...config.nftMode!, enabled: false } }; nft.render(); await settle();
    assert.equal(find(nft.output(), (node) => node.type?.name === "TokenPosts").props.owner, false);
  } finally { nft.unmount(); }
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
    find(runtime.output(), (node) => node.type?.name === "TokenHero").props.onTrade();
    assert.deepEqual([scrolled.at(-1), focused.at(-1)], ["trade", "trade"], "the stacked layout's Trade button moves to the trade card");
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

test("the tabs follow the hero and precede the trade aside, so reading and keyboard order match the layout", () => {
  const html = render({ token: coin });
  const order = ['id="token-title"', 'role="tablist"', 'id="token-panel-overview"', 'id="trade"', 'id="beneficiary-title"'].map((marker) => html.indexOf(marker));
  assert(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), `DOM order ${order}`);
  assert.match(html, /class="primary small-button token-hero-trade"[^>]*>Trade \$SYN/);
  assert.match(html, /id="trade" tabindex="-1"/, "the trade card can take focus from the hero button");
  assert.doesNotMatch(render({ token: coin, stateInvalid: true }), /token-hero-trade/, "no jump to trading links that are hidden");
});

test("NFT Posts management stays available when new NFT launches are disabled", async () => {
  account = creator;
  let holder = creator, reads = 0;
  const runtime = await detailRuntime({ token: muse, runtime: { ...config, nftMode: { ...config.nftMode!, enabled: false } },
    status: async () => { throw Error("Launch-mode endpoint must not be called"); }, postHolder: async () => { reads++; return holder; } });
  try {
    runtime.render(); await settle();
    find(runtime.output(), node => node.props?.id === "token-tab-posts").props.onClick(); await settle();
    assert.equal(find(runtime.output(), node => node.type?.name === "TokenPosts").props.owner, true);
    assert.equal(find(runtime.output(), node => node.type?.name === "TokenHero").props.onEdit, undefined, "profile launch gate stays intact");
    assert.equal(reads, 1);
    holder = "0x3333333333333333333333333333333333333333"; account = holder; runtime.render(); await settle();
    assert.equal(find(runtime.output(), node => node.type?.name === "TokenPosts").props.owner, true, "wallet changes reread the holder");
    assert.equal(reads, 2);
  } finally { runtime.unmount(); }
});

test("the selected tab lives in the URL: a copied link opens it, and switching rewrites only the tab parameter", async (t) => {
  const saved = ["location", "history"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const), writes: string[] = [];
  const place = { origin: "https://musegod.fun", pathname: `/token/robinhood/${coin.address}`, search: "?ref=x&tab=onchain", hash: "#top" };
  Object.defineProperty(globalThis, "location", { configurable: true, value: place });
  Object.defineProperty(globalThis, "history", { configurable: true, value: { state: { kept: true }, replaceState(state: unknown, _title: string, url: string) {
    assert.deepEqual(state, { kept: true }, "the history entry's state is kept"); writes.push(url); place.search = new URL(url, place.origin).search;
  } } });
  t.after(() => { for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); });
  const runtime = await detailRuntime();
  const tab = (name: string) => find(runtime.output(), (node) => node.props?.id === `token-tab-${name}`);
  try {
    runtime.render();
    assert.equal(tab("onchain").props["aria-selected"], true, "a link to On-chain opens On-chain");
    assert(find(runtime.output(), (node) => node.type?.name === "TokenContract"), "and renders its panel on load");
    tab("activity").props.onClick(); await settle();
    tab("overview").props.onClick(); await settle();
    tab("overview").props.onClick(); await settle();
    assert.deepEqual(writes, [`${place.pathname}?ref=x&tab=activity#top`, `${place.pathname}?ref=x#top`], "Overview drops the parameter; no rewrite when unchanged");
    place.search = "?tab=onchain"; window.dispatchEvent(new Event("popstate")); await settle();
    assert.equal(tab("onchain").props["aria-selected"], true, "history moving to another tab's URL selects that tab");
    assert.equal(writes.length, 2, "following history never rewrites it");
  } finally { runtime.unmount(); }
  // Start a fresh page on Overview so Activity has never mounted before the history navigation.
  place.search = "?ref=x";
  const overview = await detailRuntime();
  try {
    overview.render();
    assert.equal(find(overview.output(), (node) => node.props?.id === "token-tab-overview").props["aria-selected"], true);
    assert.equal(find(overview.output(), (node) => node.type?.name === "TokenActivity"), null);
    place.search = "?ref=x&tab=activity"; window.dispatchEvent(new Event("popstate")); await settle();
    assert.equal(find(overview.output(), (node) => node.props?.id === "token-tab-activity").props["aria-selected"], true);
    assert(find(overview.output(), (node) => node.type?.name === "TokenActivity"), "history mounts a previously unvisited Activity panel");
    assert.equal(writes.length, 2, "following history never rewrites it");
  } finally { overview.unmount(); }
  place.search = "?ref=x&tab=posts";
  const posts = await detailRuntime();
  try {
    posts.render();
    assert.equal(find(posts.output(), (node) => node.props?.id === "token-tab-posts").props["aria-selected"], true);
    const feed = find(posts.output(), (node) => node.type?.name === "TokenPosts");
    assert(feed, "a Posts deep link mounts the feed on the first render");
    find(posts.output(), (node) => node.props?.id === "token-tab-overview").props.onClick(); await settle();
    assert(find(posts.output(), (node) => node.type?.name === "TokenPosts"), "a visited feed stays mounted while hidden");
    assert.equal(find(posts.output(), (node) => node.props?.id === "token-panel-posts").props.hidden, true);
  } finally { posts.unmount(); }
  const { tokenTabFromSearch, searchWithTokenTab } = await import("../src/lib/token-detail");
  assert.deepEqual(["", "?tab=activity", "?tab=onchain", "?tab=posts", "?tab=ACTIVITY"].map(tokenTabFromSearch), ["overview", "activity", "onchain", "posts", "overview"]);
  assert.equal(searchWithTokenTab("?tab=activity", "overview"), "");
});

test("a profile the server could not read shows no launch links and no editor; a stale one says when it was last confirmed", () => {
  account = creator;
  const unavailable = render({ token: coin, profileStatus: "unavailable" });
  assert.doesNotMatch(unavailable, /x\.com\/musegod_rh/, "a launch link the owner may have replaced never returns in its place");
  assert.match(unavailable, /Channel links are temporarily unavailable\. Retrying automatically\./);
  assert.doesNotMatch(unavailable, /Edit profile|Channels<\/dt>/, "no editor prefilled from launch links, no channel count");
  const replaced = { ...EMPTY_PROFILE_LINKS, website: "https://b.example.org/" };
  const stale = render({ token: coin, profile: { links: replaced, signer: creator, issuedAt: 1, savedAt: 1 }, profileStatus: "stale", profileCheckedAt: Date.UTC(2026, 9, 18) });
  assert.match(stale, /href="https:\/\/b\.example\.org\/"/);
  assert.match(stale, /Links last confirmed <time datetime="2026-10-18T00:00:00.000Z">/i);
  assert.doesNotMatch(stale, /x\.com\/musegod_rh|Edit profile/);
  assert.match(render({ token: coin }), /Edit profile/, "a definitive answer still offers editing to the owner");
  for (const detail of [{ token: coin, profile: { links: EMPTY_PROFILE_LINKS, signer: creator, issuedAt: 1, savedAt: 1 } },
    { token: { ...coin, twitter: undefined } }]) {
    const html = render({ ...detail, profileStatus: "stale", profileCheckedAt: Date.UTC(2026, 9, 18) });
    assert.match(html, /<h2 id="channels-title" class="card-title">Channels<\/h2><p class="feed-note" role="status">Links last confirmed/,
      "a stale answer with no links (a cleared profile, or none saved and no launch links) still says when it was confirmed");
    assert.doesNotMatch(html, /x\.com\/musegod_rh|Edit profile|Channels · /);
  }
});

test("an open editor locks when a refresh makes the profile answer stale or unavailable, until it closes", async () => {
  account = creator;
  for (const profileStatus of ["stale", "unavailable"]) {
    const runtime = await detailRuntime();
    const editor = () => find(runtime.output(), (node) => node.type?.name === "ProfileEditor");
    let form: Awaited<ReturnType<typeof detailEditorRuntime>> | undefined;
    try {
      runtime.render(); find(runtime.output(), (node) => node.type?.name === "TokenHero").props.onEdit(); await settle();
      assert(editor(), "the editor opens on a definitive answer");
      const mounted = editor().type;
      let signatures = 0;
      form = await detailEditorRuntime(runtime, async () => { signatures++; return { signer: creator, signature: "0x1234" }; });
      form.render();
      find(form.output(), (node) => node.type === "input" && node.props.name === "website").props.onChange({ target: { value: "https://typed.example.org/" } });
      await settle();
      runtime.props.detail = { ...runtime.props.detail, profileStatus, profileCheckedAt: 1 } as any; runtime.render(); await settle();
      assert.equal(editor().type, mounted, `${profileStatus}: the same editor stays mounted`);
      form.render();
      assert.equal(button(form.output(), "Sign and save").props.disabled, true);
      assert(find(form.output(), (node) => node.props?.role === "status" && textOf(node) === blockedEditorReason));
      assert.equal(find(form.output(), (node) => node.type === "input" && node.props.name === "website").props.value, "https://typed.example.org/");
      form.submit(); await settle(); assert.equal(signatures, 0, "form submission cannot bypass the lock");
      runtime.props.detail = { ...runtime.props.detail, profileStatus: undefined } as any; runtime.render(); await settle();
      form.render();
      assert.equal(button(form.output(), "Sign and save").props.disabled, true, "a later definitive answer does not unlock the old prefill");
      assert.equal(editor().props.blocked, blockedEditorReason);
      editor().props.onClose(); await settle(); assert.equal(editor(), null);
      find(runtime.output(), (node) => node.type?.name === "TokenHero").props.onEdit(); await settle();
      assert.equal(editor().props.blocked, undefined, "closing and reopening after a definitive answer clears the lock");
    } finally { form?.unmount(); runtime.unmount(); }
  }
});

test("after a save on this page, the newer profile wins and a later stale or unavailable answer still governs editing", async () => {
  account = creator;
  const at = (issuedAt: number, website: string) => ({ links: { ...EMPTY_PROFILE_LINKS, website }, signer: creator, issuedAt, savedAt: issuedAt });
  for (const profileStatus of ["stale", "unavailable"]) {
    const runtime = await detailRuntime();
    const hero = () => find(runtime.output(), (node) => node.type?.name === "TokenHero");
    const editor = () => find(runtime.output(), (node) => node.type?.name === "ProfileEditor");
    const shown = () => hero().props.links.map((link: any) => link.href);
    let form: Awaited<ReturnType<typeof detailEditorRuntime>> | undefined;
    try {
      runtime.render(); hero().props.onEdit(); await settle();
      editor().props.onSaved(at(20, "https://b.example.org/")); editor().props.onClose(); await settle();
      runtime.props.detail = { ...runtime.props.detail, profile: at(10, "https://a.example.org/") } as any; runtime.render(); await settle();
      assert.deepEqual(shown(), ["https://b.example.org/"], "an older served answer does not replace this page's newer save");
      hero().props.onEdit(); await settle(); assert(editor(), "the owner can reopen the editor");
      const mounted = editor().type;
      let finish!: (value: { signer: string; signature: string }) => void;
      form = await detailEditorRuntime(runtime, () => new Promise((resolve) => { finish = resolve; }));
      form.render(); form.submit(); await settle();
      assert.match(textOf(form.output()), /Sign in your wallet/);
      runtime.props.detail = { ...runtime.props.detail, profile: profileStatus === "stale" ? at(30, "https://c.example.org/") : undefined, profileStatus,
        profileCheckedAt: Date.UTC(2026, 9, 18) } as any;
      runtime.render(); await settle();
      assert.equal(editor().type, mounted, `${profileStatus}: a pending signature keeps its editor mounted`);
      form.render();
      assert.equal(button(form.output(), "Sign and save").props.disabled, true);
      assert(find(form.output(), (node) => node.props?.role === "status" && textOf(node) === blockedEditorReason));
      assert.equal(hero().props.onEdit, undefined);
      if (profileStatus === "stale") {
        assert.deepEqual(shown(), ["https://c.example.org/"], "a newer save from elsewhere replaces this page's own");
        assert.match(textOf(runtime.output()), /Links last confirmed/);
      } else assert.deepEqual(shown(), [], "unavailable hides links even after a local save");
      runtime.props.detail = { ...runtime.props.detail, profileStatus: undefined } as any; runtime.render(); await settle(); form.render();
      assert.equal(button(form.output(), "Sign and save").props.disabled, true, "a definitive refresh keeps the editor locked");
      finish({ signer: creator, signature: "0x1234" }); await settle();
      assert.equal(form.calls.length, 1, "the signature already in flight still submits its save");
      assert.equal(form.saved.length, 1, "the pending save still calls onSaved");
      assert.deepEqual(shown(), ["https://b.example.org/"], "the saved editor values reach the page");
    } finally { form?.unmount(); runtime.unmount(); }
  }
});

test("a pool quote keeps its read time and a refresh button, expires after a minute, and a failed refresh never passes as new", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 9, 18, 6) });
  const { quoteAsset } = await import("../src/lib/config");
  let amount = 2n * 10n ** 18n, fail = false, quoteSlow: Promise<{ amountOut: string }> | null = null, View: any;
  const runtime = hookRuntime(() => View({ token: coin, stock: quoteAsset(coin), market, fomoHandle: null,
    quoteProbe: async () => { if (fail) throw new Error("Pool read failed"); if (quoteSlow) return quoteSlow; return { amountOut: amount.toString() }; } }));
  ({ default: View } = await importFresh("src/components/TokenVenues.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } }));
  const text = () => textOf(runtime.output()), time = () => find(runtime.output(), (node) => node.type === "time")?.props.dateTime;
  try {
    runtime.render(); button(runtime.output(), "Get pool quote").props.onClick(); await settle();
    assert.match(text(), /≈ 0.5 WETH per SYN.*Read at /); assert.equal(time(), "2026-10-18T06:00:00.000Z");
    assert.doesNotMatch(text(), /expired/);
    t.mock.timers.tick(60_000); await settle();
    assert.match(text(), /expired, refresh for a current quote/, "an old figure is labelled, never refreshed on its own");
    amount = 4n * 10n ** 18n; button(runtime.output(), "Refresh pool quote").props.onClick(); await settle();
    assert.match(text(), /≈ 0.25 WETH/); assert.equal(time(), "2026-10-18T06:01:00.000Z"); assert.doesNotMatch(text(), /expired|not current/);
    fail = true; button(runtime.output(), "Refresh pool quote").props.onClick(); await settle();
    assert.match(text(), /≈ 0.25 WETH.*Previous quote, read at .* · not current/); assert.equal(time(), "2026-10-18T06:01:00.000Z");
    assert.match(text(), /Pool read failed/);
    assert(button(runtime.output(), "Refresh pool quote"), "the refresh stays available after a failure");
    let answer!: (value: { amountOut: string }) => void;
    fail = false; const slow = new Promise<{ amountOut: string }>((resolve) => { answer = resolve; });
    quoteSlow = slow;
    button(runtime.output(), "Refresh pool quote").props.onClick(); await settle();
    assert.match(text(), /Reading the pool…/);
    assert.match(text(), /≈ 0.25 WETH.*Previous quote, read at .* · not current/, "a pending retry does not make the failed figure look current");
    answer({ amountOut: (5n * 10n ** 18n).toString() }); await settle();
    assert.match(text(), /≈ 0.2 WETH/); assert.doesNotMatch(text(), /not current|Pool read failed/);
  } finally { runtime.unmount(); }
});

test("an unanswered profile refreshes the detail with backoff, and repeated failed refreshes keep the 15 s state retry going", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answers: (() => unknown)[] = [], calls: number[] = [];
  let clock = 0, View: any;
  const runtime = hookRuntime(() => View({ address: coin.address, config }));
  const { useResource } = await importFresh("src/lib/resource.ts", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "./api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async () => { calls.push(clock); return (answers.shift() ?? answers.at(-1) ?? (() => { throw new Error("no answer"); }))(); } } },
    "./network": { file: import.meta.resolve("../src/lib/network.tsx"), bindings: { useNetwork: () => ({ chainId: 4663 }) } },
  });
  ({ TokenPage: View } = await importFresh("src/App.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "./lib/resource": { file: import.meta.resolve("../src/lib/resource.ts"), bindings: { useResource } },
  }, ["TokenPage"]));
  const wait = async (ms: number) => { for (let step = 0; step < ms; step += 1_000) { clock += 1_000; t.mock.timers.tick(1_000); await settle(); } };
  const unanswered = () => ({ token: coin, state: { poolKey: {} }, profileStatus: "unavailable" });
  try {
    for (let i = 0; i < 6; i++) answers.push(unanswered);
    runtime.render(); await settle();
    await wait(400_000);
    const gaps = calls.slice(1).map((at, index) => at - calls[index]);
    assert.deepEqual(gaps.slice(0, 5), [15_000, 30_000, 60_000, 120_000, 120_000], "profile-only retries back off");
    answers.length = 0; answers.push(() => ({ token: coin, state: { poolKey: {} } }));
    await wait(120_000); const settled = calls.length; await wait(600_000);
    assert.equal(calls.length, settled, "a definitive answer stops the retries");
  } finally { runtime.unmount(); }
  // Pool state and profile both missing, then two identical failed refreshes: the 15 s retry continues and recovers.
  calls.length = 0; clock = 0;
  const offline = () => { throw new Error("offline"); };
  answers.push(() => ({ token: coin, state: null, profileStatus: "unavailable" }), offline, offline, () => ({ token: coin, state: { poolKey: {} } }));
  const second = hookRuntime(() => View({ address: coin.address, config }));
  const { useResource: useResource2 } = await importFresh("src/lib/resource.ts", {
    react: { file: import.meta.resolve("react"), bindings: second.hooks },
    "./api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async () => { calls.push(clock); return (answers.shift() ?? (() => ({ token: coin, state: { poolKey: {} } })))(); } } },
    "./network": { file: import.meta.resolve("../src/lib/network.tsx"), bindings: { useNetwork: () => ({ chainId: 4663 }) } },
  });
  ({ TokenPage: View } = await importFresh("src/App.tsx", {
    react: { file: import.meta.resolve("react"), bindings: second.hooks },
    "./lib/resource": { file: import.meta.resolve("../src/lib/resource.ts"), bindings: { useResource: useResource2 } },
  }, ["TokenPage"]));
  try {
    second.render(); await settle(); await wait(120_000);
    assert.deepEqual(calls, [0, 15_000, 30_000, 45_000], "every settled request, failed or not, schedules the next one");
  } finally { second.unmount(); }
});

test("the creator fee is the trading fee times the creator's share, and falls back to the share when the trading fee is unknown", async () => {
  const { creatorFeePercent } = await import("../src/lib/token-detail");
  assert.equal(creatorFeePercent(coin), "0.665%");
  assert.equal(creatorFeePercent({ ...coin, tradingFeeBps: 300 }), "1.995%");
  assert.equal(creatorFeePercent({ ...coin, tradingFeeBps: undefined }), null);
  assert.equal(creatorFeePercent({ ...coin, feePolicy: undefined }), null);
  assert.match(render({ token: { ...coin, tradingFeeBps: undefined } }), /<span class="eyebrow muted">Creator share<\/span><span class="mono">66.5%<\/span><span class="hint">of every trading fee/);
});
