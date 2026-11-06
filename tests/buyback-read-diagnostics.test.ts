import assert from "node:assert/strict";
import test from "node:test";
import {
  countedBuybackFetch, currentBuybackReadDiagnostics, recordBuybackRpcAttempt,
  runBuybackReadDiagnostics, withBuybackReadPhase, type BuybackReadDiagnostics,
} from "../server/buyback-read-diagnostics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("parallel fresh reads isolate fetches, methods and phases while reporting overlap", async () => {
  const a = deferred<Response>(), b = deferred<Response>(), storage = deferred<Response>();
  const rpcFetch = countedBuybackFetch("rpc", input => String(input).endsWith("a") ? a.promise : b.promise);
  const storageFetch = countedBuybackFetch("storage", () => storage.promise);
  let firstInside: BuybackReadDiagnostics | undefined, secondInside: BuybackReadDiagnostics | undefined;
  const first = runBuybackReadDiagnostics(() => withBuybackReadPhase("first", async () => {
    recordBuybackRpcAttempt("eth_chainId", false);
    const pending = rpcFetch("https://fixture.invalid/a");
    firstInside = currentBuybackReadDiagnostics();
    await pending;
    return "first value";
  }));
  const second = runBuybackReadDiagnostics(() => withBuybackReadPhase("second", async () => {
    recordBuybackRpcAttempt("eth_call", false);
    recordBuybackRpcAttempt("eth_call", true);
    const pending = Promise.all([rpcFetch("https://fixture.invalid/b"), storageFetch("https://fixture.invalid/storage")]);
    secondInside = currentBuybackReadDiagnostics();
    await pending;
    return "second value";
  }));
  assert.equal(currentBuybackReadDiagnostics(), undefined);
  assert.notEqual(firstInside!.readId, secondInside!.readId);
  a.resolve(new Response("a"));
  b.resolve(new Response("b"));
  storage.resolve(new Response("storage"));
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.value, "first value");
  assert.equal(two.value, "second value");
  assert.equal(one.diagnostics.rpcFetches, 1);
  assert.equal(one.diagnostics.storageFetches, 0);
  assert.equal(one.diagnostics.maxActiveFetches, 1);
  assert.equal(firstInside!.activeFetches, 1);
  assert.equal(firstInside!.activeFetchesAtCompletion, null);
  assert.equal(one.diagnostics.activeFetches, 0);
  assert.equal(one.diagnostics.activeFetchesAtCompletion, 0);
  assert.equal(one.diagnostics.activeReadsAtStart, 1);
  assert.equal(one.diagnostics.maxConcurrentReads, 2);
  assert.deepEqual(one.diagnostics.rpcMethods, { eth_chainId: { attempts: 1, retries: 0 } });
  assert.deepEqual(Object.keys(one.diagnostics.byPhase), ["first"]);
  assert.equal(two.diagnostics.rpcFetches, 1);
  assert.equal(two.diagnostics.storageFetches, 1);
  assert.equal(two.diagnostics.maxActiveFetches, 2);
  assert.equal(two.diagnostics.activeReadsAtStart, 2);
  assert.equal(two.diagnostics.maxConcurrentReads, 2);
  assert.equal(two.diagnostics.rpcAttempts, 2);
  assert.equal(two.diagnostics.rpcRetries, 1);
  assert.deepEqual(two.diagnostics.rpcMethods, { eth_call: { attempts: 2, retries: 1 } });
  assert.deepEqual(Object.keys(two.diagnostics.byPhase), ["second"]);
});

test("nested phases attribute each dispatch once and snapshots cannot mutate the live counters", async () => {
  const rpc = countedBuybackFetch("rpc", async () => new Response("fixture"));
  const result = await runBuybackReadDiagnostics(() => withBuybackReadPhase("graph", async () => {
    await rpc("https://fixture.invalid/outer");
    await withBuybackReadPhase("feeds", async () => {
      recordBuybackRpcAttempt("eth_call", false);
      await rpc("https://fixture.invalid/inner");
      const snapshot = currentBuybackReadDiagnostics()!;
      snapshot.rpcFetches = 999;
      snapshot.byPhase["graph/feeds"].rpcAttempts = 999;
    });
    await rpc("https://fixture.invalid/outer-again");
  }));
  assert.equal(result.diagnostics.rpcFetches, 3);
  assert.equal(result.diagnostics.rpcAttempts, 1);
  assert.equal(result.diagnostics.byPhase.graph.rpcFetches, 2);
  assert.equal(result.diagnostics.byPhase["graph/feeds"].rpcFetches, 1);
  assert.equal(result.diagnostics.byPhase["graph/feeds"].rpcAttempts, 1);
  assert.equal(result.diagnostics.maxActiveFetches, 1);
  assert.equal(result.diagnostics.maxConcurrentReads, 1);
});

test("failure callbacks retain the read id and only safe rejection categories leave diagnostics", async () => {
  const secret = "private-credential-123";
  const runtimeFailure = new Error(`upstream https://private.invalid/${secret}`, {
    cause: new Error(`Too many API requests by single worker invocation. body=${secret}`),
  });
  const calls: unknown[][] = [];
  const response = new Response(`private body ${secret}`, { status: 429, headers: { "x-private": secret } });
  const rateLimited = countedBuybackFetch("rpc", (input, init) => {
    calls.push([input, init]);
    return Promise.resolve(response);
  });
  const rejectedStorage = countedBuybackFetch("storage", () => Promise.reject(runtimeFailure));
  const request = new Request(`https://private.invalid/${secret}`);
  const init = { headers: { authorization: secret }, body: secret, method: "POST" };
  let readId: string | undefined, completed: BuybackReadDiagnostics | undefined;
  await assert.rejects(() => runBuybackReadDiagnostics(async () => {
    readId = currentBuybackReadDiagnostics()!.readId;
    const observed = await rateLimited(request, init);
    assert.equal(observed, response);
    assert.equal(observed.bodyUsed, false);
    recordBuybackRpcAttempt(`eth_call?key=${secret}`, true);
    await withBuybackReadPhase(`https://private.invalid/${secret}`, () => rejectedStorage(request, init));
  }, diagnostics => { completed = diagnostics; }), error => error === runtimeFailure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], request);
  assert.equal(calls[0][1], init);
  assert.equal(completed!.readId, readId);
  assert.equal(completed!.rpcFetches, 1);
  assert.equal(completed!.storageFetches, 1);
  assert.equal(completed!.http429s, 1);
  assert.equal(completed!.runtimeBudgetRejections, 1);
  assert.equal(completed!.byPhase.other.runtimeBudgetRejections, 1);
  assert.deepEqual(completed!.rpcMethods, { other: { attempts: 1, retries: 1 } });
  assert.doesNotMatch(JSON.stringify(completed), /private|credential|authorization|headers|body=|https/);
  assert.equal(currentBuybackReadDiagnostics(), undefined);
  const next = await runBuybackReadDiagnostics(async () => "ok");
  assert.equal(next.diagnostics.activeReadsAtStart, 1, "failed reads release their overlap slot");
});

test("outside-scope fetches pass through directly and diagnostic callbacks cannot change read outcomes", async () => {
  const response = new Response("fixture"), pending = Promise.resolve(response);
  const calls: unknown[][] = [];
  const rpc = countedBuybackFetch("rpc", (input, init) => { calls.push([input, init]); return pending; });
  const init = { method: "GET" };
  assert.equal(rpc("https://fixture.invalid", init), pending);
  recordBuybackRpcAttempt("eth_call", false);
  assert.equal(currentBuybackReadDiagnostics(), undefined);
  assert.deepEqual(calls, [["https://fixture.invalid", init]]);
  assert.equal(await withBuybackReadPhase("unused", async () => 7), 7);
  const result = await runBuybackReadDiagnostics(async () => 3, () => { throw new Error("logger unavailable"); });
  assert.equal(result.value, 3);
  assert.equal(result.diagnostics.rpcFetches, 0);
  const original = new Error("original failure");
  await assert.rejects(() => runBuybackReadDiagnostics(async () => { throw original; }, () => { throw new Error("logger unavailable"); }), error => error === original);
});

test("synchronous fetch rejection is counted and rethrown without an implicit retry", async () => {
  const original = Object.assign(new Error("429 https://private.invalid/secret"), { status: 429 });
  let calls = 0;
  const rpc = countedBuybackFetch("rpc", () => { calls++; throw original; });
  let completed: BuybackReadDiagnostics | undefined;
  await assert.rejects(() => runBuybackReadDiagnostics(async () => {
    assert.throws(() => rpc("https://fixture.invalid"), error => error === original);
    throw original;
  }, diagnostics => { completed = diagnostics; }), error => error === original);
  assert.equal(calls, 1);
  assert.equal(completed!.rpcFetches, 1);
  assert.equal(completed!.http429s, 1);
  assert.equal(completed!.maxActiveFetches, 1);
  assert.equal(completed!.runtimeBudgetRejections, 0);
  assert.doesNotMatch(JSON.stringify(completed), /private|secret/);
});

test("fail-fast reads expose pending work and correlate later retries without changing the completed snapshot", async t => {
  const secret = "private-credential-456", first = deferred<Response>();
  const original = new Error(`read failed at https://private.invalid/${secret}`);
  const lateFailure = new Error(`Too many subrequests. key=${secret}`);
  const lateResponse = Promise.resolve(new Response("late result"));
  const calls: string[] = [], logs: Record<string, unknown>[] = [];
  t.mock.method(console, "warn", (line: string) => { logs.push(JSON.parse(line)); });
  const rpc = countedBuybackFetch("rpc", input => {
    calls.push(String(input));
    return calls.length === 1 ? first.promise : lateResponse;
  });
  const storage = countedBuybackFetch("storage", input => {
    calls.push(String(input));
    return Promise.reject(lateFailure);
  });
  let sibling!: Promise<void>, completed: BuybackReadDiagnostics | undefined;
  await assert.rejects(() => runBuybackReadDiagnostics(async () => {
    sibling = withBuybackReadPhase("assets", async () => {
      recordBuybackRpcAttempt("eth_call", false);
      await rpc(`https://private.invalid/initial?key=${secret}`);
      // Represents an independent sibling's backoff/retry after Promise.all
      // has already rejected the enclosing read. Nothing waits for it here.
      await withBuybackReadPhase("retry", async () => {
        recordBuybackRpcAttempt("eth_call", true);
        recordBuybackRpcAttempt(`eth_${secret}`, true);
        assert.equal(rpc(`https://private.invalid/retry?key=${secret}`), lateResponse);
        await lateResponse;
      });
      await withBuybackReadPhase("storage", async () => {
        await assert.rejects(() => storage(`https://private.invalid/storage?key=${secret}`), error => error === lateFailure);
      });
    });
    await Promise.all([Promise.reject(original), sibling]);
  }, diagnostics => { completed = diagnostics; }), error => error === original);
  assert.equal(calls.length, 1, "the read finishes without waiting for its sibling");
  assert.equal(completed!.activeFetches, 1);
  assert.equal(completed!.activeFetchesAtCompletion, 1);
  assert.equal(completed!.rpcAttempts, 1);
  assert.equal(completed!.rpcRetries, 0);
  assert.equal(completed!.rpcFetches, 1);
  assert.equal(logs.length, 0);
  const frozen = JSON.stringify(completed);
  first.resolve(new Response("first response", { status: 429 }));
  await sibling;
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(completed), frozen, "late work never changes the completed accounting boundary");
  assert.equal(logs.length, 4);
  assert(logs.every(row => row.event === "buyback_engine_late_io" && row.readId === completed!.readId));
  assert.deepEqual(logs.map(({ readId: _readId, ...row }) => row), [
    { event: "buyback_engine_late_io", phase: "assets/retry", source: "rpc", kind: "rpc_attempt", method: "eth_call", retry: true },
    { event: "buyback_engine_late_io", phase: "assets/retry", source: "rpc", kind: "rpc_attempt", method: "other", retry: true },
    { event: "buyback_engine_late_io", phase: "assets/retry", source: "rpc", kind: "fetch" },
    { event: "buyback_engine_late_io", phase: "assets/storage", source: "storage", kind: "fetch" },
  ]);
  assert.doesNotMatch(JSON.stringify({ completed, logs }), /private|credential|https|headers|body|Too many/);
});
