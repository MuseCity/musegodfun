import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NftFeeNotice } from "../src/components/NftLaunchStep";

test("a transient fee refusal never offers repayment for a paid record", () => {
  const html = renderToStaticMarkup(createElement(NftFeeNotice, {
    rejection: { code: "NFT_FEE_PENDING", message: "Wait for two confirmations." }, paid: true, onDiscard: () => {},
  }));
  assert.match(html, /still confirming/);
  assert.match(html, /review again in a minute/);
  assert.doesNotMatch(html, /Pay a new fee|<button|pay a new fee/i);
});

test("a definitive fee refusal keeps the explicit repayment action only for a paid record", () => {
  const props = { rejection: { code: "NFT_FEE_INVALID" as const, message: "Wrong recipient." }, paid: true, onDiscard: () => {} };
  const html = renderToStaticMarkup(createElement(NftFeeNotice, props));
  assert.match(html, /Wrong recipient/);
  assert.match(html, /<button[^>]*>Pay a new fee<\/button>/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(NftFeeNotice, { ...props, paid: false })), /<button/);
});
