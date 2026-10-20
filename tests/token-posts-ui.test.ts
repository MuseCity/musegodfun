import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PostCard, PostText } from "../src/components/TokenPosts";
import type { PostApiKey, TokenPost } from "../src/lib/token-posts";
import { syntheticToken } from "./fixtures";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

const creator = "0x2222222222222222222222222222222222222222";
const token = syntheticToken({ mode: "robinhood", deploymentChainId: 4663, creator, name: "Muse updates", symbol: "MUSE", image: "https://images.example.org/token.webp" });
const post: TokenPost = { id: "c05cfb1c-2cdf-46b2-8c26-bdab60fa6718", text: "Latest update", images: [], videoUrl: "", createdAt: Date.now() };
const key: PostApiKey = { id: "5af0691a-18e3-482d-b272-adf1ff090aca", name: "Research Agent", prefix: "mgp_preview", issuer: creator,
  createdAt: Date.now(), expiresAt: Date.now() + 30 * 86_400_000, revokedAt: null };
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : [];
const textOf = (node: any): string => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
const button = (tree: any, text: string) => nodes(tree).find((node) => node.type === "button" && textOf(node) === text);
test.before(() => { if (!("location" in globalThis)) Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://musegod.fun" } }); });

test("Posts text linkifies public HTTPS safely while HTML, private URLs and unsafe schemes remain text", () => {
  const html = renderToStaticMarkup(createElement(PostText, { text: '<img src=x onerror=alert(1)>\nhttps://musegod.fun/news, https://127.0.0.1/a https://host.local/x javascript:alert(1) https://user:pass@musegod.fun/' }));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img/);
  assert.match(html, /href="https:\/\/musegod\.fun\/news" target="_blank" rel="noopener noreferrer"/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(html, /https:\/\/127\.0\.0\.1\/a/); assert.match(html, /javascript:alert/);
});

test("a public Post uses the coin identity, labels Agent publishing and renders images with an external video card only", () => {
  const html = renderToStaticMarkup(createElement(PostCard, { token, post: { ...post, images: [{ id: key.id, url: "https://gateway.pinata.cloud/ipfs/image" }], videoUrl: "https://www.youtube.com/watch?v=example" } }));
  assert.match(html, /Muse updates/); assert.match(html, />Agent<\/span>/); assert.match(html, /images\.example\.org\/token.webp/);
  assert.match(html, /alt="Image 1 posted by Muse updates" loading="lazy" decoding="async" referrerPolicy="no-referrer"/);
  assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=example" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Watch video/); assert.doesNotMatch(html, /<iframe|<video|<script/);
});

async function postsRuntime(options: { owner?: boolean; account?: string | null; call?: (...args: any[]) => Promise<any>; sign?: (...args: any[]) => Promise<any> } = {}) {
  let View: any;
  const calls: any[][] = [], signed: any[][] = [];
  const wallet = { account: options.account === undefined ? creator : options.account, chainId: 4663, revision: 0,
    connection: () => ({ account: wallet.account, chainId: wallet.chainId }), switchChain: async (chainId: number) => { wallet.chainId = chainId; },
    signPostAction: async (...args: any[]) => { signed.push(args); return options.sign ? options.sign(...args) : { signer: creator, signature: "0x1234" }; } };
  const props = { token, owner: options.owner ?? false };
  const runtime = hookRuntime(() => View(props));
  ({ default: View } = await importFresh("src/components/TokenPosts.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => wallet } },
    "../lib/api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async (...args: any[]) => { calls.push(args); return options.call ? options.call(...args) : { items: [post], nextCursor: null }; } } },
  }));
  const node = (find: (node: any) => boolean) => nodes(runtime.output()).find(find);
  return { ...runtime, props, wallet, calls, signed, node };
}

test("anonymous Posts load 20 at a time, append cursor results without duplicates and preserve the list after a read failure", async () => {
  let fail = false;
  const second = { ...post, id: key.id, text: "Older update" };
  const runtime = await postsRuntime({ account: null, call: async (_chain, path) => {
    if (fail) throw new Error("Posts temporarily unavailable");
    return path.includes("cursor=") ? { items: [post, second], nextCursor: null } : { items: [post], nextCursor: "opaque+cursor" };
  } });
  try {
    runtime.render(); await settle();
    assert.equal(runtime.calls[0][0], 4663); assert.match(runtime.calls[0][1], /posts\?limit=20$/);
    assert.equal(runtime.node((node) => node.type?.name === "PostKeysDialog"), undefined);
    assert.equal(button(runtime.output(), "Agent API keys"), undefined);
    button(runtime.output(), "Load more Posts").props.onClick(); await settle();
    assert.match(runtime.calls[1][1], /limit=20&cursor=opaque%2Bcursor$/);
    assert.equal(nodes(runtime.output()).filter((node) => node.type?.name === "PostCard").length, 2);
    fail = true; runtime.node((node) => node.props?.["aria-label"] === "Refresh Posts").props.onClick(); await settle();
    assert.match(textOf(runtime.output()), /Posts temporarily unavailable/);
    assert.equal(nodes(runtime.output()).filter((node) => node.type?.name === "PostCard").length, 2);
    assert.doesNotMatch(textOf(runtime.output()), /No Posts yet/);
  } finally { runtime.unmount(); }
});

test("an empty successful Posts list differs from a failed first read and stale requests cannot update an unmounted feed", async () => {
  for (const fail of [false, true]) {
    const runtime = await postsRuntime({ call: async () => { if (fail) throw new Error("Cannot load Posts"); return { items: [], nextCursor: null }; } });
    try { runtime.render(); await settle(); assert.match(textOf(runtime.output()), fail ? /Cannot load Posts/ : /No Posts yet/); if (fail) assert.doesNotMatch(textOf(runtime.output()), /No Posts yet/); }
    finally { runtime.unmount(); }
  }
  let finish!: (value: any) => void;
  const delayed = await postsRuntime({ call: async () => new Promise((resolve) => { finish = resolve; }) });
  delayed.render(); const signal = delayed.calls[0][3].signal; delayed.unmount(); assert(signal.aborted);
  finish({ items: [post], nextCursor: null }); await settle();
  assert.equal(nodes(delayed.output()).filter((node) => node.type?.name === "PostCard").length, 0);
});

test("only the owner sees delete controls and deleting a post signs that ID once before removing it", async () => {
  const runtime = await postsRuntime({ owner: true, call: async (_chain, path) => path.endsWith("/delete") ? { deleted: true } : { items: [post], nextCursor: null } });
  try {
    runtime.render(); await settle();
    runtime.node((node) => node.props?.["aria-label"] === "Delete post").props.onClick(); await settle();
    button(runtime.output(), "Sign and delete").props.onClick(); button(runtime.output(), "Sign and delete").props.onClick(); await settle();
    assert.equal(runtime.signed.length, 1); assert.deepEqual(runtime.signed[0].slice(0, 5), [token.address, "delete-post", post.id, "", 4663]);
    assert.match(runtime.calls[1][1], new RegExp(`/posts/${post.id}/delete$`));
    assert.deepEqual(runtime.calls[1][3], { once: true, retry: false });
    assert.equal(nodes(runtime.output()).filter((node) => node.type?.name === "PostCard").length, 0);
  } finally { runtime.unmount(); }
});

test("changing the wallet closes key management and discards a signature that arrives from the previous owner", async () => {
  let finish!: (value: any) => void;
  const runtime = await postsRuntime({ owner: true, sign: async () => new Promise((resolve) => { finish = resolve; }) });
  try {
    runtime.render(); await settle(); button(runtime.output(), "Agent API keys").props.onClick(); await settle();
    assert(runtime.node((node) => node.type?.name === "PostKeysDialog"));
    runtime.node((node) => node.props?.["aria-label"] === "Delete post").props.onClick(); await settle();
    button(runtime.output(), "Sign and delete").props.onClick(); await settle();
    runtime.wallet.account = "0x3333333333333333333333333333333333333333"; runtime.props.owner = false; runtime.render(); await settle();
    assert.equal(runtime.node((node) => node.type?.name === "PostKeysDialog"), undefined);
    finish({ signer: creator, signature: "0x1234" }); await settle();
    assert.equal(runtime.calls.length, 1, "no delete request after account change");
  } finally { runtime.unmount(); }
});

test("a wrong wallet network offers an explicit switch before key management and cannot delete a Post", async () => {
  const runtime = await postsRuntime({ owner: true });
  try {
    runtime.wallet.chainId = 8453; runtime.render(); await settle();
    assert.equal(runtime.node((node) => node.props?.["aria-label"] === "Delete post").props.disabled, true);
    assert.equal(button(runtime.output(), "Agent API keys"), undefined);
    button(runtime.output(), "Switch wallet network").props.onClick(); await settle(); runtime.render();
    assert.equal(runtime.wallet.chainId, 4663); assert.equal(runtime.signed.length, 0);
    button(runtime.output(), "Agent API keys").props.onClick(); await settle();
    assert(runtime.node((node) => node.type?.name === "PostKeysDialog"));
  } finally { runtime.unmount(); }
});

async function keysRuntime(options: { token?: typeof token; call?: (...args: any[]) => Promise<any>; sign?: (...args: any[]) => Promise<any> } = {}) {
  let View: any, closed = 0;
  const calls: any[][] = [], signed: any[][] = [];
  const wallet = { account: creator, chainId: 4663, connection: () => ({ account: creator, chainId: 4663 }), switchChain: async () => {},
    signPostAction: async (...args: any[]) => { signed.push(args); return options.sign ? options.sign(...args) : { signer: creator, signature: "0x1234" }; } };
  const runtime = hookRuntime(() => View({ token: options.token ?? token, onClose: () => { closed++; } }));
  ({ PostKeysDialog: View } = await importFresh("src/components/TokenPosts.tsx", {
    react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
    "../lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => wallet } },
    "../lib/api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: { chainApi: async (...args: any[]) => { calls.push(args); return options.call ? options.call(...args) : { key, apiKey: "mgp_secret_test_only" }; } } },
  }, ["PostKeysDialog"]));
  const name = () => nodes(runtime.output()).find((node) => node.type === "input" && !node.props.readOnly);
  const submit = () => nodes(runtime.output()).find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  return { ...runtime, calls, signed, name, submit, closed: () => closed };
}

test("key creation binds a client UUID and name, displays the secret once and keeps it out of Agent instructions", async (t) => {
  const copied: string[] = [], storage: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator"), savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied.push(value); } } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: (value: string) => { storage.push(value); } } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else Reflect.deleteProperty(globalThis, "navigator"); if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage); else Reflect.deleteProperty(globalThis, "localStorage"); });
  const runtime = await keysRuntime();
  try {
    runtime.render(); assert.equal(runtime.calls.length, 0, "opening never requests a wallet signature");
    runtime.name().props.onChange({ target: { value: "Research Agent" } }); await settle(); runtime.submit(); runtime.submit(); await settle();
    assert.equal(runtime.signed.length, 1); const action = runtime.signed[0];
    assert.deepEqual(action.slice(0, 2), [token.address, "create-key"]); assert.match(action[2], /^[0-9a-f-]{36}$/); assert.equal(action[3], "Research Agent");
    assert.equal(runtime.calls[0][2].keyId, action[2]); assert.equal(runtime.calls[0][2].name, "Research Agent");
    assert.match(textOf(runtime.output()), /only display/); assert.equal(nodes(runtime.output()).find((node) => node.type === "input" && node.props.readOnly).props.value, "mgp_secret_test_only");
    button(runtime.output(), "Copy API key").props.onClick(); await settle();
    button(runtime.output(), "Copy Agent instructions").props.onClick(); await settle();
    assert.equal(copied[0], "mgp_secret_test_only"); assert.match(copied[1], /Chain ID: 4663/); assert.match(copied[1], /agent-posts\.md/); assert(!copied[1].includes("mgp_secret_test_only"));
    assert.match(copied[1], /read, publish and delete Posts and upload/);
    assert.deepEqual(storage, []);
    button(runtime.output(), "I saved the key").props.onClick(); await settle(); assert(!nodes(runtime.output()).some((node) => node.type === "input" && node.props.value === "mgp_secret_test_only"));
    assert.match(textOf(runtime.output()), /mgp_preview/);
  } finally { runtime.unmount(); }
});

test("listing and revocation are separately signed, and neither operation reveals a saved secret", async () => {
  const runtime = await keysRuntime({ call: async (_chain, path) => path.endsWith("/list") ? { keys: [key] } : { revoked: true } });
  try {
    runtime.render(); button(runtime.output(), "Load all keys").props.onClick(); await settle();
    assert.deepEqual(runtime.signed[0].slice(1, 4), ["list-keys", "", ""]);
    assert.match(textOf(runtime.output()), /Research Agent/); assert.doesNotMatch(textOf(runtime.output()), /Save this API key/);
    button(runtime.output(), "Revoke").props.onClick(); await settle(); button(runtime.output(), "Confirm revoke").props.onClick(); await settle();
    assert.deepEqual(runtime.signed[1].slice(1, 4), ["revoke-key", key.id, ""]); assert.match(runtime.calls[1][1], new RegExp(`/post-api-keys/${key.id}/revoke$`));
    assert.match(textOf(runtime.output()), /Revoked/); assert.equal(button(runtime.output(), "Revoke"), undefined);
  } finally { runtime.unmount(); }
});

test("NFT key guidance describes checks on each write and the transfer-away-and-back limitation", async () => {
  const runtime = await keysRuntime({ token: { ...token, nft: { chainId: 4663, contract: token.address, tokenId: "1" } } });
  try {
    runtime.render(); const text = textOf(runtime.output());
    assert.match(text, /Each write checks the current holder/); assert.match(text, /Transfers away and back between checks may go unobserved/);
    assert.match(text, /Revoke keys before transferring/); assert.doesNotMatch(text, /Keys stop working when the NFT changes hands/);
  } finally { runtime.unmount(); }
});

test("key manager errors keep the dialog open, and unmount before signing completes sends no HTTP request", async () => {
  const denied = await keysRuntime({ sign: async () => { throw Object.assign(new Error("User rejected"), { code: 4001 }); } });
  try { denied.render(); button(denied.output(), "Load all keys").props.onClick(); await settle(); assert.match(textOf(denied.output()), /You cancelled the wallet request/); assert.equal(denied.calls.length, 0); assert.equal(denied.closed(), 0); }
  finally { denied.unmount(); }
  let finish!: (value: any) => void;
  const delayed = await keysRuntime({ sign: async () => new Promise((resolve) => { finish = resolve; }) });
  delayed.render(); button(delayed.output(), "Load all keys").props.onClick(); await settle(); delayed.unmount();
  finish({ signer: creator, signature: "0x1234" }); await settle(); assert.equal(delayed.calls.length, 0);
});
