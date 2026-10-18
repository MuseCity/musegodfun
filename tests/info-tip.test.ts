import assert from "node:assert/strict";
import test from "node:test";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

// The review's info tips (owner, 2026-10-18): text while a mouse is over the icon or the text, on keyboard focus, or after a tap; linked
// to its button for screen readers. While it shows, the first Escape hides it and stops there; otherwise Escape reaches the dialog.

test.before(() => { Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: new EventTarget() }); });

async function infoTip(t: { after(run: () => void): void }) {
  let View: any;
  const runtime = hookRuntime(() => View({ id: "tip", label: "About NFT collections", text: "Not investment advice." }));
  ({ default: View } = await importFresh("src/components/InfoTip.tsx", { react: { file: import.meta.resolve("react"), bindings: runtime.hooks } }));
  t.after(() => runtime.unmount());
  const parts = (tree: any) => { const [button, text] = tree.props.children; return { root: tree.props, button: button.props, text: text.props }; };
  const now = async () => { await settle(); return parts(runtime.render()); };
  return { now, first: parts(runtime.render()) };
}
/** A key or pointer event dispatched at the document, as the browser would deliver it. */
function at(type: string, extra: Record<string, unknown> = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), extra);
  document.dispatchEvent(event); return event;
}
const shown = (part: { root: Record<string, unknown> }) => part.root["data-shown"] === "true";

test("the text is the button's description and stays in the page while hidden", async (t) => {
  const { first } = await infoTip(t);
  assert.equal(first.button.type, "button");
  assert.equal(first.button["aria-label"], "About NFT collections");
  assert.equal(first.button["aria-describedby"], "tip");
  assert.deepEqual({ role: first.text.role, id: first.text.id, children: first.text.children }, { role: "tooltip", id: "tip", children: "Not investment advice." });
  assert.equal(shown(first), false);
  assert.equal(at("keydown", { key: "Escape" }).defaultPrevented, false, "a hidden tip leaves Escape to the dialog");
});

test("a mouse shows it over the icon or its text; a touch does not count as hovering", async (t) => {
  const { now, first } = await infoTip(t);
  first.root.onPointerEnter({ pointerType: "touch" });
  assert.equal(shown(await now()), false);
  first.root.onPointerEnter({ pointerType: "mouse" });
  assert.equal(shown(await now()), true);
  (await now()).root.onPointerLeave({ pointerType: "mouse" });
  assert.equal(shown(await now()), false);
});

test("a tap opens it; a second tap or a tap elsewhere closes it", async (t) => {
  const { now, first } = await infoTip(t);
  first.button.onClick();
  assert.equal(shown(await now()), true);
  (await now()).button.onClick();
  assert.equal(shown(await now()), false);
  (await now()).button.onClick();
  assert.equal(shown(await now()), true);
  at("pointerdown");
  assert.equal(shown(await now()), false, "iOS gives a tapped button no focus, so a tap elsewhere closes it");
});

test("while it shows, the first Escape hides it and stops there, wherever focus is; the next reaches the dialog", async (t) => {
  const { now, first } = await infoTip(t);
  first.root.onPointerEnter({ pointerType: "mouse" });
  await now();
  const firstEscape = at("keydown", { key: "Escape" });
  assert.equal(firstEscape.defaultPrevented, true, "the dialog does not close");
  const hidden = await now();
  assert.equal(shown(hidden), false);
  assert.equal(at("keydown", { key: "Escape" }).defaultPrevented, false);
  hidden.root.onPointerLeave({ pointerType: "mouse" }); hidden.root.onPointerEnter({ pointerType: "mouse" });
  assert.equal(shown(await now()), true, "hovering again shows it again");
});

test("keyboard focus shows it; pointer focus alone does not; leaving the button hides it", async (t) => {
  const { now, first } = await infoTip(t);
  first.button.onFocus({ currentTarget: { matches: (selector: string) => selector === ":focus-visible" && false } });
  assert.equal(shown(await now()), false);
  (await now()).button.onFocus({ currentTarget: { matches: (selector: string) => selector === ":focus-visible" } });
  assert.equal(shown(await now()), true);
  (await now()).button.onBlur();
  assert.equal(shown(await now()), false);
});
