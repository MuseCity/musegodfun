import test from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, custom, encodeFunctionData, erc20Abi, toHex, InvalidInputRpcError, InvalidParamsRpcError, MethodNotFoundRpcError,
  MethodNotSupportedRpcError, type Address, type Hash } from "viem";
import { robinhood } from "viem/chains";
import { signingRequest, walletMethodPolicy, type WalletRequest } from "../src/lib/wallet-signing";
import { assertLaunchRequest } from "../src/lib/launch-wallet";
import { assertBuybackRequest } from "../src/lib/wallet";
import type { BuybackStep } from "../src/lib/buyback";

// Every provider below records JSON-RPC in memory. No wallet or network is contacted.
const account: Address = "0x1111111111111111111111111111111111111111";
const target: Address = "0x2222222222222222222222222222222222222222";
const other: Address = "0x3333333333333333333333333333333333333333";
const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [other, 10n] });
const hash = `0x${"a".repeat(64)}` as Hash;
const step = { to: target, data, value: "0", from: account, chainId: robinhood.id };
const tx = { from: account, to: target, data, value: "0x0", chainId: toHex(robinhood.id), gas: "0x5208" };
const SENDS = ["eth_sendTransaction", "wallet_sendTransaction"];
const SIGNS = ["eth_signTransaction", "eth_sign", "personal_sign", "eth_signTypedData", "eth_signTypedData_v1", "eth_signTypedData_v3", "eth_signTypedData_v4"];
const READS = ["eth_chainId", "net_version", "eth_accounts", "eth_requestAccounts", "eth_blockNumber", "eth_call", "eth_estimateGas",
  "eth_feeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getLogs",
  "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByHash",
  "wallet_switchEthereumChain", "wallet_addEthereumChain"];
// Batches, raw transactions, and anything else that could sign or send but is on no list. Object keys must not leak in either.
const REFUSED = ["wallet_sendCalls", "eth_sendRawTransaction", "wallet_sendPreparedCalls", "wallet_sendTransactions", "eth_sendUserOperation",
  "eth_signUserOperation", "eth_signTypedData_v2", "eth_signTypedData_v5", "eth_signAuthorization", "personal_signTransaction",
  "wallet_signTransaction", "eth_sign_typed", "wallet_grantPermissions", "wallet_invokeSnap", "constructor", "__proto__", "toString", ""];

const methodError = (code: number, message: string) => Object.assign(new Error(message), { code });
function harness(answer: (request: WalletRequest) => unknown = () => hash, options: { guard?: (request: WalletRequest) => void; record?: boolean; validate?: () => void } = {}) {
  const log: string[] = [];
  const provider = { request: async (request: WalletRequest) => { log.push(`wallet:${request.method}`); return answer(request); } };
  const request = signingRequest(provider, {
    guardRequest: (request) => { log.push(`guard:${request.method}`); options.guard?.(request); },
    validate: async () => { log.push("validate"); options.validate?.(); },
    ...(options.record === false ? {} : { beforeSend: (resend: boolean) => { log.push(`record:${resend}`); } }),
  });
  return { log, request };
}

test("the signing policy lists every read, broadcast and signing method and refuses everything else", () => {
  for (const method of SENDS) assert.equal(walletMethodPolicy(method), "send", method);
  for (const method of SIGNS) assert.equal(walletMethodPolicy(method), "sign", method);
  for (const method of READS) assert.equal(walletMethodPolicy(method), "read", method);
  for (const method of REFUSED) assert.equal(walletMethodPolicy(method), "refuse", method);
});

test("every broadcast and signing method is validated before the wallet receives it, and only broadcasts are recorded", async () => {
  for (const method of SENDS) {
    const { log, request } = harness();
    assert.equal(await request({ method, params: [tx] }), hash);
    assert.deepEqual(log, [`guard:${method}`, "validate", "record:false", `wallet:${method}`], method);
  }
  for (const method of SIGNS) {
    const { log, request } = harness();
    await request({ method, params: [tx] });
    assert.deepEqual(log, [`guard:${method}`, "validate", `wallet:${method}`], method);
  }
});

test("read and wallet-management methods pass through the flow guard without validation or a record", async () => {
  for (const method of READS) {
    const { log, request } = harness(() => "0x1");
    assert.equal(await request({ method, params: [] }), "0x1");
    assert.deepEqual(log, [`guard:${method}`, `wallet:${method}`], method);
  }
});

test("batches, raw transactions and unknown signing-like methods are refused before any guard, validation or wallet", async () => {
  for (const method of REFUSED) {
    const { log, request } = harness();
    await assert.rejects(() => request({ method, params: [tx] }) as Promise<unknown>, /not allowed/, method);
    assert.deepEqual(log, [], method);
  }
});

test("wallet_sendTransaction is refused like eth_sendTransaction when validation or the flow guard refuses it", async () => {
  for (const method of SENDS) {
    // The server switch or network changed: nothing is recorded and the wallet never sees the request.
    const paused = harness(undefined, { validate: () => { throw new Error("signing paused"); } });
    await assert.rejects(() => paused.request({ method, params: [tx] }) as Promise<unknown>, /signing paused/);
    assert.deepEqual(paused.log, [`guard:${method}`, "validate"], method);
    // A transaction other than the frozen one.
    for (const changed of [{ to: other }, { data: "0x12345678" }, { value: "0x1" }, { from: other }, { chainId: "0x1" }]) {
      const guarded = harness(undefined, { guard: (request) => assertLaunchRequest(request, step) });
      await assert.rejects(() => guarded.request({ method, params: [{ ...tx, ...changed }] }) as Promise<unknown>, /does not match/);
      assert.deepEqual(guarded.log, [`guard:${method}`], `${method} ${JSON.stringify(changed)}`);
    }
  }
});

test("flow guards accept wallet_sendTransaction with the same checks as eth_sendTransaction", () => {
  const buyback = { batchId: "batch-1", kind: "burn", chainId: 4663, from: account, to: target, data, value: "0", amount: "10", nonce: 7,
    stockAddress: other, expiresAt: Date.now() + 60_000 } as BuybackStep;
  const guards: [string, (request: WalletRequest) => void, Record<string, unknown>][] = [
    ["launch", (request) => assertLaunchRequest(request, step), tx],
    ["buyback", (request) => assertBuybackRequest(request, buyback), { ...tx, nonce: toHex(7) }],
  ];
  for (const [name, guard, sent] of guards) {
    assert.doesNotThrow(() => guard({ method: "eth_chainId" }), name);
    for (const method of SENDS) {
      assert.doesNotThrow(() => guard({ method, params: [sent] }), `${name} ${method}`);
      for (const changed of [{ to: other }, { from: other }, { data: "0x12345678" }, { value: "0x1" }, { chainId: "0x1" }, { authorizationList: [] }])
        assert.throws(() => guard({ method, params: [{ ...sent, ...changed }] }), `${name} ${method} ${JSON.stringify(changed)}`);
      assert.throws(() => guard({ method, params: [sent, sent] }), `${name} ${method} two transactions`);
    }
    for (const method of [...SIGNS, ...REFUSED.slice(0, 2)]) assert.throws(() => guard({ method, params: [sent] }), `${name} ${method}`);
  }
});

type RefusalClass = typeof MethodNotSupportedRpcError | typeof MethodNotFoundRpcError | typeof InvalidParamsRpcError | typeof InvalidInputRpcError;
/** A wallet that refuses eth_sendTransaction itself (`Refusal`), so viem 2.56.8 retries the same transaction through wallet_sendTransaction. */
function namespaceWallet(Refusal: RefusalClass, options: { guard?: (request: WalletRequest) => void; record?: boolean; validate?: () => void } = {}) {
  const log: string[] = [];
  let recorded = 0;
  const provider = { request: async (request: WalletRequest) => {
    log.push(`wallet:${request.method}`);
    if (request.method === "eth_chainId") return toHex(robinhood.id);
    if (request.method === "eth_sendTransaction") throw new Refusal(new Error("The wallet refused eth_sendTransaction"));
    if (request.method === "wallet_sendTransaction") {
      // The payment must already be on record when the wallet receives the retried request.
      if (options.record !== false) assert.ok(recorded > 0, "recorded before wallet_sendTransaction");
      return hash;
    }
    throw new Error(`Unexpected wallet method ${request.method}`);
  } };
  const wallet = createWalletClient({ account, chain: robinhood, transport: custom({ request: signingRequest(provider, {
    guardRequest: (request) => { options.guard?.(request); },
    validate: async () => { log.push("validate"); options.validate?.(); },
    ...(options.record === false ? {} : { beforeSend: (resend: boolean) => { recorded++; log.push(`record:${resend}`); } }),
  }) }, { retryCount: 0 }) });
  return { log, send: () => wallet.sendTransaction({ to: target, data, value: 0n, gas: 21_000n }) };
}

test("viem's wallet_sendTransaction fallback is validated, guarded and recorded before the wallet receives it", async () => {
  // The wallet never processed the transaction.
  for (const Refusal of [MethodNotSupportedRpcError, MethodNotFoundRpcError, InvalidParamsRpcError]) {
    const code = Refusal.name;
    // A guarded flow (launch, first buy, LI.FI trade, claim): the frozen transaction passes on both methods.
    const guarded = namespaceWallet(Refusal, { guard: (request) => assertLaunchRequest(request, step) });
    assert.equal(await guarded.send(), hash);
    assert.deepEqual(guarded.log, ["wallet:eth_chainId", "validate", "record:false", "wallet:eth_sendTransaction",
      "validate", "record:true", "wallet:wallet_sendTransaction"], `guarded ${code}`);
    // An unguarded flow without a record (pair trades, MUSEGOD trades): still validated on the fallback.
    const plain = namespaceWallet(Refusal, { record: false });
    assert.equal(await plain.send(), hash);
    assert.deepEqual(plain.log, ["wallet:eth_chainId", "validate", "wallet:eth_sendTransaction", "validate", "wallet:wallet_sendTransaction"], `plain ${code}`);
  }
});

test("a validation refusal on the fallback stops it before the wallet", async () => {
  let validations = 0;
  const wallet = namespaceWallet(MethodNotSupportedRpcError, { validate: () => { if (++validations > 1) throw new Error("The platform configuration changed"); } });
  await assert.rejects(wallet.send, /platform configuration changed/);
  assert.deepEqual(wallet.log, ["wallet:eth_chainId", "validate", "record:false", "wallet:eth_sendTransaction", "validate"]);
});

test("a signer that records its transaction sends only that transaction", async () => {
  // After the wallet accepted it, no second broadcast of any kind.
  for (const method of SENDS) {
    const { log, request } = harness();
    await request({ method: "eth_sendTransaction", params: [tx] });
    await assert.rejects(() => request({ method, params: [tx] }) as Promise<unknown>, /already sent/);
    assert.deepEqual(log, ["guard:eth_sendTransaction", "validate", "record:false", "wallet:eth_sendTransaction", `guard:${method}`], method);
  }
  // Never while the first request is still open in the wallet.
  {
    let release!: (value: unknown) => void;
    const { log, request } = harness(() => new Promise((resolve) => { release = resolve; }));
    const first = request({ method: "eth_sendTransaction", params: [tx] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(() => request({ method: "wallet_sendTransaction", params: [tx] }) as Promise<unknown>, /already sent/);
    release(hash);
    assert.equal(await first, hash);
    assert.equal(log.filter((entry) => entry.startsWith("wallet:")).length, 1);
  }
  // The wallet refused the method, but the retry is a different transaction, or not viem's eth_ → wallet_ fallback.
  for (const [second, params] of [["wallet_sendTransaction", [{ ...tx, value: "0x1" }]], ["eth_sendTransaction", [tx]]] as const) {
    const { log, request } = harness((request) => { if (request.method === "eth_sendTransaction") throw methodError(-32004, "unsupported"); return hash; });
    await assert.rejects(() => request({ method: "eth_sendTransaction", params: [tx] }) as Promise<unknown>, /unsupported/);
    await assert.rejects(() => request({ method: second, params }) as Promise<unknown>);
    assert.deepEqual(log.filter((entry) => entry.startsWith("wallet:") || entry.startsWith("record:")), ["record:false", "wallet:eth_sendTransaction"], second);
  }
  // Only one fallback.
  {
    const { log, request } = harness(() => { throw methodError(-32004, "unsupported"); });
    await assert.rejects(() => request({ method: "eth_sendTransaction", params: [tx] }) as Promise<unknown>);
    await assert.rejects(() => request({ method: "wallet_sendTransaction", params: [tx] }) as Promise<unknown>);
    await assert.rejects(() => request({ method: "wallet_sendTransaction", params: [tx] }) as Promise<unknown>);
    assert.deepEqual(log.filter((entry) => entry.startsWith("wallet:")), ["wallet:eth_sendTransaction", "wallet:wallet_sendTransaction"]);
  }
});

test("an ambiguous wallet error never lets viem resend a recorded payment; the wallet's own error stands", async () => {
  // InvalidInputRpcError (-32000) is also viem's fallback trigger, but a wallet may have broadcast before answering it.
  const recorded = namespaceWallet(InvalidInputRpcError);
  await assert.rejects(recorded.send, (error: Error & { walk: (fn: (cause: unknown) => boolean) => unknown }) =>
    (error.walk((cause) => (cause as { code?: number }).code === -32000) as { code?: number } | null)?.code === -32000);
  assert.deepEqual(recorded.log, ["wallet:eth_chainId", "validate", "record:false", "wallet:eth_sendTransaction"]);
  // Without a record there is nothing to double-charge: the fallback is validated like any other broadcast.
  const plain = namespaceWallet(InvalidInputRpcError, { record: false });
  assert.equal(await plain.send(), hash);
  assert.deepEqual(plain.log, ["wallet:eth_chainId", "validate", "wallet:eth_sendTransaction", "validate", "wallet:wallet_sendTransaction"]);
});

test("a signer without a record may send several validated transactions (approvals, then the swap)", async () => {
  const { log, request } = harness(undefined, { record: false });
  for (const method of [...SENDS, ...SENDS]) assert.equal(await request({ method, params: [tx] }), hash);
  assert.equal(log.filter((entry) => entry === "validate").length, 4);
  assert.equal(log.filter((entry) => entry.startsWith("wallet:")).length, 4);
});

