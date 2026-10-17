import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PriceChartFrame from "../src/components/PriceChartFrame";

test("empty and loading frames share a symbol watermark, with status only beneath the panel", () => {
  for (const unit of [undefined, "USD", "WETH"]) for (const text of ["Loading market data…", "No price history yet", "Chart data temporarily unavailable"] as const) {
    const reason = text === "Chart data temporarily unavailable" ? "The price provider is rate limited. Try again later." : text;
    const html = renderToStaticMarkup(createElement(PriceChartFrame, { symbol: "TEST", unit, status: { text, reason } }));
    assert(html.includes(`<div class="chart-watermark" aria-hidden="true">TEST${unit ? ` / ${unit}` : ""}</div>`));
    assert(html.indexOf('class="chart-status"') > html.indexOf('class="chart-credit"'), "status follows the complete chart panel");
    const frame = html.split('<div class="chart-frame">')[1].split('<div class="chart-credit">')[0];
    assert.equal(frame.replace(/<[^>]*>/g, ""), `TEST${unit ? ` / ${unit}` : ""}`, "only the non-data watermark is visible inside the frame");
    assert(html.includes(`aria-description="${reason}"`));
    assert(html.includes(`title="${reason}">${text}</p>`));
    assert(html.includes(`. ${text}"`), "accessible name agrees with visible status");
  }
});

test("populated frames have real OHLC and price inspection without a watermark or empty status", () => {
  for (const type of ["candles", "line"] as const) {
    const html = renderToStaticMarkup(createElement(PriceChartFrame, { symbol: "TEST", unit: "USD", type, count: 1, bar: { open: 1, high: 3, low: 1, close: 2 } }));
    assert.doesNotMatch(html, /chart-watermark|chart-status|aria-description|is-empty/);
    assert.match(html, /Drag, zoom, and hover to inspect prices/);
    assert.equal((html.match(/<b>/g) ?? []).length, 4);
  }
});

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Declarations that apply to one selector at a viewport width. Only max-width media queries are resolved; any other at-rule is skipped.
function stylesAt(selector: string, viewport: number) {
  const styles: Record<string, string> = {}, open: boolean[] = [];
  for (const [, atRule, selectors, body] of css.matchAll(/(@[^{}]*)\{|([^{}@]+)\{([^{}]*)\}|\}/g)) {
    if (atRule !== undefined) open.push(viewport <= Number(/\(max-width:\s*(\d+)px\)/.exec(atRule)?.[1] ?? -1));
    else if (selectors === undefined) open.pop();
    else if (open.every(Boolean) && selectors.split(",").some(part => part.trim() === selector)) {
      for (const declaration of body.split(";")) { const colon = declaration.indexOf(":"); if (colon > 0) styles[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim(); }
    }
  }
  return styles;
}

// Height the legend header occupies: its flex-wrapped content, or the reserved minimum when that is taller. Widths use IBM Plex Mono's
// 0.6 em advance; `inset` is the viewport width not available to the chart panel (card and page padding, plus the 15 px classic
// scrollbar that the archived 390 px capture, with its 311 px panel, included).
function legendHeight(items: string[], viewport: number, inset: number) {
  const styles = stylesAt(".chart-ohlc", viewport);
  assert(styles.gap && styles.margin && styles["line-height"] && styles["font-size"], "the legend's layout declarations must be readable");
  const [rowGap, columnGap = rowGap] = styles.gap.split(/\s+/).map(parseFloat), margins = styles.margin.split(/\s+/);
  const available = viewport - inset - 2 * parseFloat(margins[margins.length > 1 ? 1 : 0]), advance = 0.6 * parseFloat(styles["font-size"]);
  let rows = 0, used = 0;
  for (const item of items) {
    const width = item.length * advance;
    if (rows && used + columnGap + width <= available) used += columnGap + width;
    else { rows += Math.ceil(width / available); used = width > available ? Infinity : width; }
  }
  return Math.max(rows * parseFloat(styles["line-height"]) + (rows - 1) * rowGap, parseFloat(styles["min-height"] ?? "0"));
}

function legendItems(props: object) {
  const html = renderToStaticMarkup(createElement(PriceChartFrame, { symbol: "TEST", ...props }));
  const legend = /<div class="chart-ohlc"[^>]*>(.*?)<\/div>/.exec(html)![1];
  return [...legend.matchAll(/<span>(.*?)<\/span>/g)].map(([, span]) => span.replace(/<[^>]*>/g, ""));
}

test("the legend header keeps one height from loading through empty to populated on phone screens", () => {
  const bar = { open: 0.000001, high: 0.000001, low: 0.000001, close: 0.000001 };
  for (const symbol of ["T", "MICROCOIN", "ABCDEFGHIJKL"]) for (const unit of [undefined, "USD", "WETH"]) {
    const label = unit ? `${symbol} / ${unit}` : symbol;
    const states = ["Loading market data…", "No price history yet", "Chart data temporarily unavailable"] as const;
    const [loading, ...rest] = states.map(text => legendItems({ symbol, unit, status: { text, reason: text } }));
    const populated = legendItems({ symbol, unit, count: 1, bar });
    assert.deepEqual(loading, [label]);
    for (const empty of rest) assert.deepEqual(empty, loading);
    assert.deepEqual(populated, [label, ...["O", "H", "L", "C"].map(key => `${key} 0.0000010000`)], "the real values stay in the legend");
    for (const inset of [64, 79]) for (let viewport = 320; viewport <= 640; viewport += 5) {
      assert.equal(legendHeight(loading, viewport, inset), legendHeight(populated, viewport, inset),
        `${label}: the plot moves when the legend fills at ${viewport}px with a ${inset}px inset`);
    }
  }
});

test("the legend shows every value in full at every width", () => {
  for (const selector of [".chart-ohlc", ".chart-ohlc b"]) for (const viewport of [320, 390, 480, 481, 1440]) {
    const styles = stylesAt(selector, viewport);
    assert(!["hidden", "clip"].includes(styles.overflow) && !styles["text-overflow"] && !styles["max-height"] && !styles["line-clamp"] && styles.display !== "none", `${selector} at ${viewport}px`);
  }
});
