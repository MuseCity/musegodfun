import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TokenCard, { type TokenCardToken } from "../src/components/TokenCard";
import { ROBINHOOD_STOCKS, STOCKS, shortAddress } from "../src/lib/config";
import type { MarketSummary } from "../src/lib/market";
import { MUSEGOD } from "../src/lib/musegod";
import type { CardMarketState } from "../src/lib/token-card-market";
import { syntheticToken } from "./fixtures";

function token(overrides: Partial<TokenCardToken> = {}): TokenCardToken {
  return { ...syntheticToken(), kind: "launch", quote: STOCKS[0], ...overrides };
}

function summary(overrides: Partial<MarketSummary> = {}): MarketSummary {
  return {
    fetchedAt: new Date().toISOString(), source: "CoinGecko", status: "fresh",
    priceUsd: 5, fdvUsd: 777, marketCapUsd: 12_345_678, liquidityUsd: 888,
    periods: { h24: { change: 2.345, volume: 9_876, buys: 2, sells: 3 } },
    ...overrides,
  };
}

function card(entry = token(), market: Partial<CardMarketState> = {}) {
  return renderToStaticMarkup(createElement(TokenCard, {
    token: entry,
    market: { data: summary(), loading: false, error: "", ...market },
    onNavigate: () => {},
  }));
}

function metricText(markup: string) {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

test("the directory card shows current market values and its existing creator and pair", () => {
  const entry = token();
  const markup = card(entry);
  const text = metricText(markup);
  assert.match(text, /Market cap \$12\.35M/);
  assert.match(text, /24h volume \$9\.88K/);
  assert.match(text, /24h change \+2\.35%/);
  assert.match(markup, /\$SYNTH/);
  assert.match(markup, new RegExp(`${entry.quote.ticker} pair`));
  assert.ok(markup.includes(shortAddress(entry.creator!)));
  assert.match(markup, /Base/);
  assert.match(markup, /CoinGecko/);
  assert.match(markup, /<time\b[^>]*datetime=/i);
  assert.doesNotMatch(markup, /Fully diluted|Liquidity|Holders|Synthetic stock-paired|openingCap/);
});

test("unknown and non-finite metrics stay unknown instead of falling back to valuation or zero", () => {
  const examples = [
    null,
    summary({ marketCapUsd: null, periods: {} }),
    summary({ marketCapUsd: Number.NaN, periods: { h24: {
      change: Number.POSITIVE_INFINITY, volume: undefined as unknown as number, buys: null, sells: null,
    } } }),
  ];
  for (const data of examples) {
    const markup = card(token(), { data });
    const text = metricText(markup);
    assert.match(text, /Market cap —/);
    assert.match(text, /24h volume —/);
    assert.match(text, /24h change —/);
    assert.doesNotMatch(markup, /NaN|Infinity|\$0|\$777|0\.00%/);
  }
});

test("real zero market values render as zero and a neutral percentage", () => {
  const markup = card(token(), { data: summary({
    marketCapUsd: 0, periods: { h24: { volume: 0, change: 0, buys: 0, sells: 0 } },
  }) });
  const text = metricText(markup);
  assert.match(text, /Market cap \$0/);
  assert.match(text, /24h volume \$0/);
  assert.match(text, /24h change 0\.00%/);
  assert.doesNotMatch(markup, /class="[^"]*\b(?:positive|negative)\b[^"]*"/);
});

test("24h gains and losses have directional classes and preserve the sign", () => {
  for (const [value, formatted, className] of [
    [2.345, "+2.35%", "positive"], [-4.234, "-4.23%", "negative"],
  ] as const) {
    const markup = card(token(), { data: summary({
      periods: { h24: { change: value, volume: 0, buys: 0, sells: 0 } },
    }) });
    assert.ok(markup.includes(formatted));
    assert.match(markup, new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`));
  }
});

test("the entire card has one native detail link, an escaped full-name title, and no nested action", () => {
  const entry = token({ name: 'A <Story> & "Launch" with a deliberately long name' });
  const markup = card(entry);
  assert.equal((markup.match(/<a\b/g) ?? []).length, 1);
  assert.match(markup, new RegExp(`href="/token/${entry.address}"`));
  assert.match(markup, /title="A &lt;Story&gt; &amp; &quot;Launch&quot; with a deliberately long name"/);
  assert.doesNotMatch(markup, /<button\b|<Story>/);
});

test("launch images use public HTTPS and suppress referrers, while unsafe or absent images use an initial", () => {
  const valid = card(token({ image: "https://images.example.org/token.png" }));
  assert.match(valid, /src="https:\/\/images\.example\.org\/token\.png"/);
  assert.match(valid, /referrerPolicy="no-referrer"/i);
  for (const image of ["", "javascript:alert(1)", "http://images.example.org/token.png", "https://127.0.0.1/token.png", "https://user:secret@images.example.org/token.png"]) {
    const markup = card(token({ image }));
    const imageRegion = markup.match(/<div class="token-card-image">(.*?)<\/div>/)?.[1] ?? "";
    assert.doesNotMatch(imageRegion, /<img\b/);
    assert.match(metricText(imageRegion), /S/);
    assert.doesNotMatch(markup, /javascript:|user:secret|127\.0\.0\.1/);
  }
});

test("the featured MUSEGOD card uses the local logo and its own venue and source, with an unknown creator", () => {
  const entry = token({
    kind: "musegod", address: MUSEGOD.token, name: MUSEGOD.name, symbol: MUSEGOD.symbol,
    image: MUSEGOD.image, creator: null, mode: "robinhood",
    quote: ROBINHOOD_STOCKS.find((asset) => asset.address.toLowerCase() === MUSEGOD.weth.toLowerCase())!,
  });
  const markup = card(entry, { data: summary({ source: "Bankr" }) });
  assert.match(markup, /src="\/asset-logos\/MUSEGOD\.png"/);
  assert.match(markup, /Featured/);
  assert.match(markup, /SushiSwap v3/);
  assert.match(markup, /Bankr \/ Pools/);
  assert.match(markup, /Robinhood Chain/);
  assert.match(metricText(markup), /Creator —/);
  assert.doesNotMatch(markup, /CoinGecko/);
  assert.equal((markup.match(/<a\b/g) ?? []).length, 1);
});

test("initial loading and unavailable data carry an explicit status without invented values", () => {
  const loading = card(token(), { data: null, loading: true });
  assert.match(loading, /Loading market data/);
  assert.match(metricText(loading), /Market cap —/);
  const unavailable = card(token({ mode: "fork" }), { data: null, error: "Local fork market data unavailable." });
  assert.match(unavailable, /Local fork market data unavailable\./);
  assert.match(metricText(unavailable), /24h volume —/);
  assert.doesNotMatch(unavailable, /\$0|0\.00%/);
});

test("a retained snapshot stays visible during refresh and is identified after a refresh failure", () => {
  const refreshing = card(token(), { loading: true });
  assert.match(metricText(refreshing), /Market cap \$12\.35M/);
  const previous = card(token(), { data: summary({ status: "stale" }), error: "Request failed" });
  assert.match(previous, /Previous snapshot/);
  assert.match(metricText(previous), /Market cap \$12\.35M/);
  assert.match(previous, /CoinGecko/);
  assert.match(previous, /<time\b[^>]*datetime=/i);
});
