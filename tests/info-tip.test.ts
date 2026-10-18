import assert from "node:assert/strict";
import test from "node:test";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

// The review's info tips (owner, 2026-10-18): text on hover, keyboard focus or tap, linked to its button for screen readers; Escape hides
// it first and only a second Escape reaches the dialog.

async function infoTip() {
  let View: any;
  const runtime = hookRuntime(() => View({ id: "tip", label: "About NFT collections", text: "Not investment advice." }));
  ({ default: View } = await importFresh("src/components/InfoTip.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } }));
  const render = async () => { await settle(); return runtime.render(); };
  const parts = (tree: any) => { const [button, text] = tree.props.children; return { root: tree.props, button: button.props, text: text.props }; };
  return { runtime, render, parts, first: parts(runtime.render()) };
}
const escape = () => { const event = { key: "Escape", prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; return event; };

test("the text is the button's description and stays in the page while closed", async () => {
  const { first } = await infoTip();
  assert.equal(first.button.type, "button");
  assert.equal(first.button["aria-label"], "About NFT collections");
  assert.equal(first.button["aria-describedby"], "tip");
  assert.deepEqual({ role: first.text.role, id: first.text.id, children: first.text.children }, { role: "tooltip", id: "tip", children: "Not investment advice." });
  assert.equal(first.root["data-open"], undefined);
});

test("a tap opens and a second tap or leaving the button closes it", async () => {
  const { render, parts, first } = await infoTip();
  first.button.onClick();
  const opened = parts(await render());
  assert.equal(opened.root["data-open"], "true");
  opened.button.onClick();
  assert.equal(parts(await render()).root["data-open"], undefined);
  parts(await render()).button.onClick();
  parts(await render()).button.onBlur();
  assert.equal(parts(await render()).root["data-open"], undefined);
});

test("Escape hides the tip without closing the dialog, and a second Escape reaches the dialog", async () => {
  const { render, parts, first } = await infoTip();
  first.button.onClick();
  const firstEscape = escape(); parts(await render()).button.onKeyDown(firstEscape);
  assert.deepEqual([firstEscape.prevented, firstEscape.stopped], [true, true]);
  const hidden = parts(await render());
  assert.deepEqual([hidden.root["data-open"], hidden.root["data-dismissed"]], [undefined, "true"]);
  const secondEscape = escape(); hidden.button.onKeyDown(secondEscape);
  assert.deepEqual([secondEscape.prevented, secondEscape.stopped], [false, false]);
  hidden.root.onMouseLeave();
  assert.equal(parts(await render()).root["data-dismissed"], undefined, "hover shows it again after the pointer leaves");
});
