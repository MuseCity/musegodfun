import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FeeBreakdown from "../src/components/FeeBreakdown";

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
