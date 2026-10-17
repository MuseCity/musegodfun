import test from "node:test";
import assert from "node:assert/strict";
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
