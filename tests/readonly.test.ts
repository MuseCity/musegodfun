import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { Snapshots, SNAPSHOT_TTL, MAX_STALE } from "../server/snapshots";
import { MarketReader } from "../server/market";
import { STOCKS } from "../src/lib/config";
import { syntheticOpeningValuation, syntheticToken } from "./fixtures";
import {
  WalletConnection,
  walletAnnouncement,
  type Provider,
  type WalletOption,
} from "../src/lib/wallet-connection";
import { mainnetRpcUrl, redact, runtimeFromEnv } from "../server/config";
import { assertSigningEnabled } from "../src/lib/validation";
import { CONTRACTS, type RuntimeConfig } from "../src/lib/config";
import { LaunchpadService } from "../server/service";
import { DopplerSDK, airlockAbi } from "@whetstone-research/doppler-sdk/evm";
import { createPublicClient, encodeFunctionData, http, keccak256, type Hex } from "viem";
import { buildLaunch } from "../src/lib/protocol";
const account = STOCKS[0].address,
  other = STOCKS[1].address;

test("service keeps an empty catalog empty and rejects unregistered or unsupported asset lookup", async () => {
  let record = syntheticToken();
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config: { mode: "base" } },
    store: { tokens: async () => [], token: async () => record },
  }) as LaunchpadService;
  assert.deepEqual(await service.tokens(), []);
  assert.equal((await service.token(record.address)).address, record.address);
  record = syntheticToken({ transactionHash: null });
  await assert.rejects(() => service.token(record.address), /Platform token not found/);
  record = syntheticToken({ quoteAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
  await assert.rejects(() => service.token(record.address), /Platform token not found/);
  record = syntheticToken({ mode: "fork" });
  await assert.rejects(() => service.token(record.address), /Platform token not found/);
});

test("wallet signing allows configured Base or local fork only and rejects a disabled or mismatched network", () => {
  const config: RuntimeConfig = {
    mode: "base", chainId: 8453, treasury: other,
    writesEnabled: true, blockReason: null,
  };
  assert.doesNotThrow(() => assertSigningEnabled(config));
  assert.doesNotThrow(() => assertSigningEnabled({ ...config, mode: "fork", chainId: 31337 }));
  assert.throws(() => assertSigningEnabled({ ...config, writesEnabled: false }), /not enabled/);
  assert.throws(() => assertSigningEnabled({ ...config, treasury: null }), /treasury address/);
  assert.throws(() => assertSigningEnabled({ ...config, chainId: 1 }), /network/);
  assert.throws(() => assertSigningEnabled({ ...config, mode: "fork" }), /network/);
});

test("Base launch tracking rejects mismatched calldata or targets; read-only rollback still reconciles submitted transactions", async () => {
  const hash = `0x${"a".repeat(64)}` as Hex;
  const draft = { name: "Read Only", symbol: "READ", description: "", image: "", quoteAddress: STOCKS[0].address };
  const sdk = new DopplerSDK<8453>({ publicClient: createPublicClient({ transport: http("http://127.0.0.1:1") }), chainId: 8453 });
  const createParams = sdk.factory.encodeCreateMulticurveParams(buildLaunch(sdk, draft, account, other, other,
    syntheticOpeningValuation(draft.quoteAddress)));
  const data = encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [createParams] });
  const planId = keccak256(data);
  let target = CONTRACTS.airlock, input = data, networkChecks = 0;
  const tracked: unknown[] = [];
  const service = Object.assign(Object.create(LaunchpadService.prototype), {
    runtime: { config: { mode: "base", chainId: 8453, writesEnabled: false } },
    assertNetwork: async () => { networkChecks++; },
    client: {
      getTransaction: async () => ({ to: target, from: account, input, value: 0n }),
      getTransactionReceipt: async () => { throw new Error("receipt pending"); },
      getBlock: async () => { throw new Error("Finalized block tag is unavailable"); },
    },
    store: {
      findPlan: async (creator: string, input: string) => creator === account && input === data ? { id: planId, creator: account, data, draft } : null,
      trackLaunch: async (...args: unknown[]) => { tracked.push(args); },
      pendingLaunches: async () => [],
    },
  }) as LaunchpadService;
  await service.trackLaunch(hash, planId);
  assert.equal(tracked.length, 1);
  input = "0x5678";
  await assert.rejects(() => service.trackLaunch(hash, planId), /does not match the issuance preview/);
  input = data;
  target = CONTRACTS.router;
  await assert.rejects(() => service.trackLaunch(hash, planId), /outer transaction/);
  assert.equal(tracked.length, 1, "Invalid tracking must not occupy the persistent queue");
  await assert.rejects(() => service.register(hash), /receipt pending/);
  const before = networkChecks;
  await service.reconcile();
  assert.equal(networkChecks, before + 1, "Disabling new signatures must not stop receipt recovery");
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "musegod-test-"));
  const store = new Store(dir, 8453);
  return {
    store,
    dir,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true });
    },
  };
}
test("snapshot coalescing, persistent quota, stale fallback, retry backoff and hard 24h expiry", async () => {
  const f = fixture();
  let now = Date.UTC(2026, 8, 22, 12),
    calls = 0;
  const cache = new Snapshots(f.store, () => now);
  const read = async () => {
    calls++;
    assert(f.store.reserveMarketCall(now, 1, 2));
    return { fetchedAt: "", value: 12 };
  };
  try {
    const snapshots = await Promise.all(
      Array.from({ length: 10 }, () => cache.get("p", "CoinGecko", read)),
    );
    assert.equal(calls, 1);
    assert.equal(snapshots[0].value, 12);
    const restarted = new Store(f.dir, 8453);
    assert.equal(restarted.reserveMarketCall(now, 1, 2), false);
    restarted.close();
    now += SNAPSHOT_TTL + 1;
    const stale = await cache.get("p", "CoinGecko", read);
    assert.equal((stale as typeof stale & { status: string }).status, "stale");
    assert.equal(stale.value, 12);
    await cache.get("p", "CoinGecko", read);
    assert.equal(calls, 2, "Manual refresh cannot bypass backoff");
    now += MAX_STALE;
    await assert.rejects(
      () =>
        cache.get("p", "CoinGecko", async () => {
          throw new Error("429");
        }),
      /No valid snapshot/,
    );
  } finally {
    f.close();
  }
});
test("CoinGecko sends Demo header only to CoinGecko; 429, missing pool, invalid body and timeout fail closed", async () => {
  for (const status of [429, 404, 500, 200, 0]) {
    const f = fixture();
    let calls = 0;
    const reader = new MarketReader({
      store: f.store,
      apiKey: "test-demo",
      fetch: async (input, init) => {
        calls++;
        assert(
          String(input).startsWith("https://api.coingecko.com/api/v3/onchain/"),
        );
        assert.equal(
          (init?.headers as Record<string, string>)["x-cg-demo-api-key"],
          "test-demo",
        );
        if (!status) throw new DOMException("timeout", "TimeoutError");
        return new Response("{}", { status });
      },
    });
    try {
      await assert.rejects(() => reader.summary(syntheticToken()));
      await assert.rejects(() => reader.summary(syntheticToken()));
      assert.equal(calls, 1);
    } finally {
      f.close();
    }
  }
});
test("monthly budget cannot be bypassed by crossing a day or reconnecting", () => {
  const f = fixture();
  try {
    const day = Date.UTC(2026, 8, 1);
    assert(f.store.reserveMarketCall(day, 300, 1));
    assert.equal(f.store.reserveMarketCall(day + 86400000, 300, 1), false);
    assert(f.store.reserveMarketCall(Date.UTC(2026, 9, 1), 300, 1));
  } finally {
    f.close();
  }
});
function fake() {
  const events = new Map<string, (v: unknown) => void>();
  let addresses = [account],
    chain = "0x2105",
    reject: unknown = null;
  let calls: string[] = [];
  const p = {
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (reject) throw reject;
      return method === "eth_chainId" ? chain : addresses;
    },
    on: (event: string, fn: (v: unknown) => void) => events.set(event, fn),
    removeListener: (event: string) => events.delete(event),
  } as Provider;
  const option: WalletOption = {
    id: crypto.randomUUID(),
    name: "Test",
    rdns: crypto.randomUUID(),
    provider: p,
  };
  return {
    p,
    option,
    events,
    calls,
    setAccounts: (a: typeof addresses) => {
      addresses = a;
      events.get("accountsChanged")?.(a);
    },
    setChain: (c: string) => {
      chain = c;
      events.get("chainChanged")?.(c);
    },
    reject: (e: unknown) => (reject = e),
  };
}
test("wallet discovery validates announcements and never trusts icon HTML", () => {
  const f = fake();
  assert.equal(
    walletAnnouncement({
      info: {
        uuid: f.option.id,
        name: "Test",
        rdns: "test.wallet",
        icon: "javascript:evil",
      },
      provider: f.p,
    })?.provider,
    f.p,
  );
  assert.equal(walletAnnouncement({ info: { name: "Fake" } }), null);
});
test("selected provider owns account, chain events and signing; disconnect removes listeners", async () => {
  const a = fake(),
    b = fake();
  const c = new WalletConnection(() => {});
  await c.select(a.option);
  assert.equal(c.state.account, account);
  await c.select(b.option);
  assert.equal(a.events.size, 0);
  a.setAccounts([other]);
  assert.equal(c.state.account, account);
  b.setAccounts([other]);
  assert.equal(c.state.account, other);
  await assert.rejects(() => c.validate(account, 8453, a.p));
  b.setChain("0x1");
  await assert.rejects(() => c.validate(other, 8453, b.p), /network does not match/);
  c.disconnect();
  assert.equal(c.state.account, null);
  assert.equal(b.events.size, 0);
});
test("wallet restore queries authorized accounts only; rejection and locked accounts are recoverable", async () => {
  const f = fake(),
    c = new WalletConnection(() => {});
  await c.select(f.option, true);
  assert(!f.calls.includes("eth_requestAccounts"));
  f.reject({ code: 4001 });
  await c.select(f.option);
  assert.match(c.state.error, /cancelled/);
  assert.equal(c.state.account, null);
  f.reject({ code: -32002 });
  await c.select(f.option);
  assert.match(c.state.error, /pending/);
  f.reject(null);
  f.setAccounts([]);
  await c.select(f.option);
  assert.match(c.state.error, /locked/);
  c.dispose();
});
test("late wallet result cannot undo a user-selected provider or a disconnect", async () => {
  const a = fake(),
    b = fake();
  let resolve!: (v: unknown) => void;
  a.p.request = ((r: { method: string }) =>
    r.method === "eth_chainId"
      ? Promise.resolve("0x2105")
      : new Promise<unknown>((r) => {
          resolve = r;
        })) as Provider["request"];
  const c = new WalletConnection(() => {});
  const pending = c.select(a.option);
  await c.select(b.option);
  c.disconnect();
  resolve([account]);
  await pending;
  assert.equal(c.state.account, null);
  assert.equal(c.selected, null);
});
test("duplicate connect requests do not open duplicate wallet prompts", async () => {
  const f = fake();
  let requests = 0,
    resolve!: (v: unknown) => void;
  f.p.request = ((r: { method: string }) =>
    r.method === "eth_chainId"
      ? Promise.resolve("0x2105")
      : (requests++,
        new Promise<unknown>((r) => (resolve = r)))) as Provider["request"];
  const c = new WalletConnection(() => {});
  const pending = c.select(f.option);
  await c.select(f.option);
  assert.equal(requests, 1);
  resolve([account]);
  await pending;
  c.dispose();
});
test("a restore started before dispose cannot block the remounted provider's restore", async () => {
  const f = fake(),
    resolvers: ((v: unknown) => void)[] = [];
  f.p.request = ((r: { method: string }) =>
    r.method === "eth_chainId"
      ? Promise.resolve("0x2105")
      : new Promise<unknown>((r) => resolvers.push(r))) as Provider["request"];
  const c = new WalletConnection(() => {});
  const first = c.select(f.option, true);
  // React StrictMode runs the provider effect cleanup and setup again with the same controller.
  c.dispose();
  const second = c.select(f.option, true);
  assert.equal(resolvers.length, 2);
  resolvers[0]([account]);
  await first;
  assert.equal(c.state.connecting, true);
  // The disposed request settling must not reopen duplicate prompts for the live one.
  await c.select(f.option);
  assert.equal(resolvers.length, 2);
  resolvers[1]([account]);
  await second;
  assert.equal(c.state.account, account);
  assert.equal(c.state.connecting, false);
  c.dispose();
});
test("account event emitted during connection keeps current account and obtains its network", async () => {
  const f = fake(),
    c = new WalletConnection(() => {});
  let resolve!: (v: unknown) => void;
  f.p.request = ((r: { method: string }) =>
    r.method === "eth_chainId"
      ? Promise.resolve("0x2105")
      : new Promise<unknown>((r) => (resolve = r))) as Provider["request"];
  const pending = c.select(f.option);
  f.setAccounts([other]);
  resolve([account]);
  await pending;
  assert.equal(c.state.account, other);
  assert.equal(c.state.chainId, 8453);
  c.dispose();
});
test("errors redact both secret values and upstream URLs; Alchemy takes precedence", () => {
  const old = process.env.ALCHEMY_API_KEY;
  try {
    process.env.ALCHEMY_API_KEY = "secret-for-test";
    assert(
      !redact(
        new Error("secret-for-test https://rpc.test/v2/secret-for-test"),
      ).includes("secret-for-test"),
    );
    assert.match(runtimeFromEnv().rpcUrl, /(?:base|robinhood)-mainnet.g.alchemy.com/);
    assert.equal(mainnetRpcUrl(8453), "https://base-mainnet.g.alchemy.com/v2/secret-for-test");
    assert.equal(mainnetRpcUrl(4663), "https://robinhood-mainnet.g.alchemy.com/v2/secret-for-test");
  } finally {
    if (old === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = old;
  }
});
test("errors redact all server-only Pinata credentials", () => {
  const names = ["PINATA_API_KEY", "PINATA_API_SECRET", "PINATA_JWT"];
  const previous = names.map(name => process.env[name]);
  try {
    const values = names.map((name, index) => `${name.toLowerCase()}-test-${index}`);
    names.forEach((name, index) => { process.env[name] = values[index]; });
    const message = redact(new Error(values.join(" ")));
    for (const value of values) assert.equal(message.includes(value), false);
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test("fork tokens and unreviewed / mismatched pools cannot link to mainnet Doppler", async () => {
  const { dopplerUrl } = await import("../src/lib/doppler");
  assert.equal(dopplerUrl(syntheticToken()), null);
  assert.equal(dopplerUrl(syntheticToken({ mode: "fork" })), null);
  assert.equal(
    dopplerUrl(syntheticToken({ poolId: `0x${"1".repeat(64)}` })),
    null,
  );
  assert.equal(dopplerUrl(syntheticToken({ address: other })), null);
});
test("transaction records preserve pending entries, chain separation and replacement status across reload", async () => {
  const savedStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    ),
    savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget(),
  });
  try {
    const { saveTransaction, transactions, updateTransaction } =
      await import("../src/lib/transactions");
    const hash = `0x${"a".repeat(64)}` as const;
    saveTransaction({
      hash,
      chainId: 31337,
      account,
      action: "launch",
      status: "pending",
      at: 1,
    });
    for (let i = 0; i < 220; i++)
      saveTransaction({
        hash: `0x${i.toString(16).padStart(64, "0")}`,
        chainId: 8453,
        account,
        action: "swap",
        status: "success",
        at: i + 2,
      });
    assert.equal(transactions().length, 201, "200 settled rows cannot evict an unresolved launch");
    assert.equal(
      transactions().find((t) => t.hash === hash)?.status,
      "pending",
    );
    updateTransaction(hash, 31337, {
      status: "replaced",
      replacement: `0x${"b".repeat(64)}`,
    });
    assert.equal(
      transactions().find((t) => t.hash === hash)?.status,
      "replaced",
    );
    assert.equal(transactions().filter((t) => t.chainId === 31337).length, 1);
    updateTransaction(hash, 31337, { status: "success", intentId: "unregistered-intent" });
    for (let i = 220; i < 440; i++) saveTransaction({
      hash: `0x${i.toString(16).padStart(64, "0")}`, chainId: 8453, account, action: "swap", status: "success", at: i + 2,
    });
    assert.equal(transactions().find((t) => t.hash === hash)?.registered, undefined,
      "an on-chain success awaiting registration survives unrelated completed transactions");
    assert.equal(transactions().filter((t) => t.chainId === 31337).length, 1);
  } finally {
    if (savedStorage)
      Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
