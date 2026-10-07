import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FeeBreakdown from "../src/components/FeeBreakdown";
import { TRADING_FEE_BPS } from "../src/lib/trading-fee";

const render = (policy?: string) => renderToStaticMarkup(createElement(FeeBreakdown, { policy }));

test("fee display separates net, platform and gross denominators", () => {
  const html = render("creator-70-musegod-v2");
  const net = html.match(/<section[^>]*aria-label="Net fee distribution"[\s\S]*?<\/section>/)?.[0] ?? "";
  const platform = html.match(/<section[^>]*aria-label="Platform income allocation"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(net, /The fees remaining after Doppler are the 100% basis/);
  assert.match(net, /<dt>Creator<\/dt><dd>70%<\/dd>/);
  assert.match(net, /<dt>Platform<\/dt><dd>30%<\/dd>/);
  assert.doesNotMatch(net, /66\.5%|22\.8%|5\.7%/);
  assert.match(platform, /Only the platform’s income is the 100% basis/);
  assert.match(platform, /<dt>MUSEGOD buyback budget<\/dt><dd>80%<\/dd>/);
  assert.match(platform, /<dt>Operating budget<\/dt><dd>20%<\/dd>/);
  const gross = html.match(/<details[\s\S]*?<\/details>/)?.[0] ?? "";
  assert.match(gross, /total fees before Doppler as the 100% basis/);
  for (const amount of ["66.5%", "22.8%", "5.7%", "5%"]) assert(gross.includes(`<dd>${amount}</dd>`));
  assert.match(html, /A budget does not represent a completed buyback or burn/);
});

test("legacy fee display keeps original proportions and no operations allocation", () => {
  const html = render("musegod-80-v1");
  assert.match(html, /retains its original fee policy/);
  assert.match(html, /<dt>Creator<\/dt><dd>20%<\/dd>/);
  assert.match(html, /<dt>MUSEGOD buyback budget<\/dt><dd>100%<\/dd>/);
  assert.match(html, /<dt>Creator<\/dt><dd>19%<\/dd>/);
  assert.match(html, /<dt>MUSEGOD buyback budget<\/dt><dd>76%<\/dd>/);
  assert.doesNotMatch(html, /Operating budget|66\.5%|22\.8%|70%/);
});

test("unmarked and unknown pools do not display current fee percentages", () => {
  for (const policy of [undefined, "future-v3"]) {
    const html = render(policy);
    assert.match(html, /no identified fee policy/);
    assert.doesNotMatch(html, /\d+%/);
  }
});

test("fee display uses the pool's verified trading fee for all nine rates", () => {
  for (const tradingFeeBps of TRADING_FEE_BPS) {
    const html = renderToStaticMarkup(createElement(FeeBreakdown, { policy: "creator-70-musegod-v2", tradingFeeBps }));
    assert.match(html, new RegExp(`The nominal total fee is ${(tradingFeeBps + 5) / 100}%`.replaceAll(".", "\\.")));
    assert.ok(html.includes(`${tradingFeeBps / 100}% trading fee + 0.05% LP fee`));
    assert.match(html, /<dt>Creator<\/dt><dd>70%<\/dd>/);
    if (tradingFeeBps !== 100) assert.doesNotMatch(html, /nominal total fee is 1\.05%/);
  }
});

test("historical and generic fee explanations do not assume a default trading fee", () => {
  for (const tradingFeeBps of [undefined, 99, 310, NaN]) {
    const html = renderToStaticMarkup(createElement(FeeBreakdown, { policy: "creator-70-musegod-v2", tradingFeeBps }));
    assert.match(html, /trading fee has not been verified here/);
    assert.doesNotMatch(html, /nominal total fee|1\.05%/);
  }
});

test("verified rates display independently of an unknown revenue policy", () => {
  for (const policy of [undefined, "future-v3"]) {
    const html = renderToStaticMarkup(createElement(FeeBreakdown, { policy, tradingFeeBps: 300 }));
    assert.match(html, /nominal total fee is 3\.05%/);
    assert.match(html, /no identified fee policy/);
    assert.doesNotMatch(html, /Net fee distribution|70%|30%/);
    assert.match(render(policy), /trading fee has not been verified here/);
  }
});
