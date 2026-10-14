import test from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, custom, encodeFunctionData, erc20Abi, toHex, InvalidInputRpcError, InvalidParamsRpcError, MethodNotFoundRpcError,
  MethodNotSupportedRpcError, UserRejectedRequestError, type Address, type Hash } from "viem";
import { robinhood } from "viem/chains";
import { signingRequest, walletMethodPolicy, walletRefusedUnsent, type WalletRequest } from "../src/lib/wallet-signing";
import { assertLaunchRequest } from "../src/lib/launch-wallet";
import { assertBuybackRequest, buybackRequest } from "../src/lib/wallet";
import type { BuybackStep } from "../src/lib/buyback";

// Every provider below records JSON-RPC in memory. No wallet or network is contacted.
const account: Address = "0x1111111111111111111111111111111111111111";
const target: Address = "0x2222222222222222222222222222222222222222";
const other: Address = "0x3333333333333333333333333333333333333333";
const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [other, 10n] });
const otherData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [other, 11n] });
const hash = `0x${"a".repeat(64)}` as Hash;
const step = { to: target, data, value: "0", from: account, chainId: robinhood.id };
const tx = { from: account, to: target, data, value: "0x0", chainId: toHex(robinhood.id), gas: "0x5208" };
const buybackStep = { batchId: "batch-1", kind: "burn", chainId: 4663, from: account, to: target, data, value: "0", amount: "10", nonce: 7,
  stockAddress: other, expiresAt: Date.now() + 60_000 } as BuybackStep;
const SENDS = ["eth_sendTransaction", "wallet_sendTransaction"];
const SIGNS = ["eth_signTransaction", "eth_sign", "personal_sign", "eth_signTypedData", "eth_signTypedData_v1", "eth_signTypedData_v3", "eth_signTypedData_v4"];
const READS = ["eth_chainId", "net_version", "eth_accounts", "eth_requestAccounts", "eth_blockNumber", "eth_call", "eth_estimateGas",
  "eth_feeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getLogs",
  "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByHash",
  "wallet_switchEthereumChain", "wallet_addEthereumChain"];
// Every signature, batches, raw transactions, and anything else on no list. Object keys must not leak in either.
const REFUSED = [...SIGNS, "wallet_sendCalls", "eth_sendRawTransaction", "wallet_sendPreparedCalls", "wallet_sendTransactions", "eth_sendUserOperation",
  "eth_signUserOperation", "eth_signTypedData_v2", "eth_signTypedData_v5", "eth_signAuthorization", "personal_signTransaction",
  "wallet_signTransaction", "eth_sign_typed", "wallet_grantPermissions", "wallet_invokeSnap", "ETH_SENDTRANSACTION", "eth_sendTransaction ",
  " wallet_sendTransaction", "constructor", "__proto__", "toString", ""];

const methodError = (code: number, message: string) => Object.assign(new Error(message), { code });
type Options = { guard?: (request: WalletRequest) => void; record?: boolean; validate?: () => void | Promise<void> };
function harness(answer: (request: WalletRequest) => unknown = () => hash, options: Options = {}) {
  const log: string[] = [], received: WalletRequest[] = [];
  const provider = { request: async (request: WalletRequest) => { log.push(`wallet:${request.method}`); received.push(request); return answer(request); } };
  const request = signingRequest(provider, {
    guardRequest: (request) => { log.push(`guard:${request.method}`); options.guard?.(request); },
    validate: async () => { log.push("validate"); await options.validate?.(); },
    ...(options.record === false ? {} : { beforeSend: (resend: boolean) => { log.push(`record:${resend}`); } }),
  });
  return { log, received, request };
}
const wallets = (log: string[]) => log.filter((entry) => entry.startsWith("wallet:"));

test("the signing policy lists every read and both send methods and refuses everything else, every signature included", () => {
  for (const method of SENDS) assert.equal(walletMethodPolicy(method), "send", method);
  for (const method of READS) assert.equal(walletMethodPolicy(method), "read", method);
  for (const method of REFUSED) assert.equal(walletMethodPolicy(method), "refuse", method);
});

test("both send methods are validated, then recorded, before the wallet receives them", async () => {
  for (const method of SENDS) {
    const { log, request } = harness();
    assert.equal(await request({ method, params: [tx] }), hash);
    assert.deepEqual(log, [`guard:${method}`, "validate", "record:false", `wallet:${method}`], method);
  }
});

test("read and wallet-management methods pass through the flow guard without validation or a record", async () => {
  for (const method of READS) {
    const { log, request } = harness(() => "0x1");
    assert.equal(await request({ method, params: [] }), "0x1");
    assert.deepEqual(log, [`guard:${method}`, `wallet:${method}`], method);
  }
});

test("signatures, batches, raw transactions and unknown methods are refused before any guard, validation or wallet", async () => {
  for (const method of REFUSED) {
    const { log, request } = harness();
    await assert.rejects(() => request({ method, params: [tx] }), /not allowed/, JSON.stringify(method));
    assert.deepEqual(log, [], method);
  }
});

test("malformed request shapes are refused before any guard, validation or wallet", async () => {
  const unserializable: unknown[] = [[{ ...tx, value: 1n }]];
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const input of [{}, null, undefined, [{ method: "eth_sendTransaction", params: [tx] }], { method: 1 }, { method: ["eth_sendTransaction"] },
    new String("eth_sendTransaction"), { method: new String("eth_sendTransaction"), params: [tx] }, "eth_sendTransaction",
    { method: "ETH_SENDTRANSACTION", params: [tx] }, { method: "eth_sendTransaction ", params: [tx] },
    { method: "eth_sendTransaction", params: unserializable }, { method: "eth_sendTransaction", params: [cyclic] },
    { method: "eth_sendTransaction", params: () => [tx] }]) {
    const { log, request } = harness();
    await assert.rejects(() => request(input), /not allowed/, String(input));
    assert.deepEqual(log, [], String(input));
  }
});

test("the guard checks a frozen copy and the wallet receives a distinct, equal copy, never the caller's object", async () => {
  const params = [{ ...tx }];
  let checked: WalletRequest | undefined;
  const { received, request } = harness(undefined, { guard: (request) => {
    assert.ok(Object.isFrozen(request) && Object.isFrozen((request.params as object[])[0]), "the guard sees the frozen copy");
    assertLaunchRequest(request, step);
    checked = request;
  }, validate: () => { params[0].to = other; params[0].data = otherData; } });
  assert.equal(await request({ method: "wallet_sendTransaction", params }), hash);
  assert.notEqual(received[0].params, params, "not the caller's params");
  assert.notEqual(received[0], checked, "not the checked copy");
  assert.notEqual((received[0].params as object[])[0], (checked!.params as object[])[0]);
  assert.deepEqual(received[0], checked, "equal to what was checked");
  assert.deepEqual(received[0], { method: "wallet_sendTransaction", params: [tx] }, "the transaction changed during validation is not sent");
});

test("a provider that adds fields to the request it receives works, and cannot change the next check", async () => {
  // Some providers stamp an `id` (and more) onto the request object; on a frozen object that throws in strict mode.
  const stamp = (request: WalletRequest) => {
    "use strict";
    Object.assign(request, { id: 1, jsonrpc: "2.0" });
    if (Array.isArray(request.params) && request.params[0] && typeof request.params[0] === "object") Object.assign(request.params[0], { to: other });
  };
  const { log, received, request } = harness((request) => { stamp(request); return request.method === "eth_chainId" ? "0x1237" : hash; });
  assert.equal(await request({ method: "eth_chainId" }), "0x1237");
  assert.equal(await request({ method: "eth_sendTransaction", params: [tx] }), hash);
  assert.deepEqual(received.map((request) => request.method), ["eth_chainId", "eth_sendTransaction"]);
  assert.deepEqual(log, ["guard:eth_chainId", "wallet:eth_chainId", "guard:eth_sendTransaction", "validate", "record:false", "wallet:eth_sendTransaction"]);
  // Through viem: the stamping wallet refuses eth_sendTransaction, and the resend is still compared with what viem asked for.
  let calls = 0;
  const provider = { request: async (request: WalletRequest) => {
    stamp(request);
    if (request.method === "eth_chainId") return toHex(robinhood.id);
    if (request.method === "eth_sendTransaction" && ++calls) throw new MethodNotSupportedRpcError(new Error("unsupported"));
    return hash;
  } };
  let records = 0;
  const client = createWalletClient({ account, chain: robinhood, transport: custom({ request: signingRequest(provider, {
    guardRequest: (request) => assertLaunchRequest(request, step), validate: async () => {}, beforeSend: () => { records++; },
  }) }, { retryCount: 0 }) });
  assert.equal(await client.sendTransaction({ to: target, data, value: 0n, gas: 21_000n }), hash);
  assert.equal(calls, 1);
  assert.equal(records, 2, "recorded before eth_sendTransaction and again before the wallet_sendTransaction resend");
});

test("two sends can never be open on one signer, with or without a record", async () => {
  for (const record of [true, false]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { log, request } = harness(undefined, { record, validate: () => gate });
    const first = request({ method: "eth_sendTransaction", params: [tx] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The slot is reserved before validation: a concurrent send (the same or another transaction) is refused at once.
    for (const params of [[tx], [{ ...tx, data: otherData }]])
      await assert.rejects(() => request({ method: "wallet_sendTransaction", params }), /already open/);
    release();
    assert.equal(await first, hash);
    assert.deepEqual(wallets(log), ["wallet:eth_sendTransaction"], `record ${record}`);
  }
});

test("wallet_sendTransaction is refused like eth_sendTransaction when validation or the flow guard refuses it", async () => {
  for (const method of SENDS) {
    // The server switch or network changed: nothing is recorded and the wallet never sees the request.
    const paused = harness(undefined, { validate: () => { throw new Error("signing paused"); } });
    await assert.rejects(() => paused.request({ method, params: [tx] }), /signing paused/);
    assert.deepEqual(paused.log, [`guard:${method}`, "validate"], method);
    // A transaction other than the frozen one.
    for (const changed of [{ to: other }, { data: "0x12345678" }, { value: "0x1" }, { from: other }, { chainId: "0x1" }]) {
      const guarded = harness(undefined, { guard: (request) => assertLaunchRequest(request, step) });
      await assert.rejects(() => guarded.request({ method, params: [{ ...tx, ...changed }] }), /does not match/);
      assert.deepEqual(guarded.log, [`guard:${method}`], `${method} ${JSON.stringify(changed)}`);
    }
  }
});

test("flow guards accept wallet_sendTransaction with the same checks as eth_sendTransaction", () => {
  const guards: [string, (request: WalletRequest) => void, Record<string, unknown>][] = [
    ["launch", (request) => assertLaunchRequest(request, step), tx],
    ["buyback", (request) => assertBuybackRequest(request, buybackStep), { ...tx, nonce: toHex(7) }],
  ];
  for (const [name, guard, sent] of guards) {
    assert.doesNotThrow(() => guard({ method: "eth_chainId" }), name);
    for (const method of SENDS) {
      assert.doesNotThrow(() => guard({ method, params: [sent] }), `${name} ${method}`);
      for (const changed of [{ to: other }, { from: other }, { data: "0x12345678" }, { value: "0x1" }, { chainId: "0x1" }, { authorizationList: [] }])
        assert.throws(() => guard({ method, params: [{ ...sent, ...changed }] }), `${name} ${method} ${JSON.stringify(changed)}`);
      assert.throws(() => guard({ method, params: [sent, sent] }), `${name} ${method} two transactions`);
    }
    for (const method of REFUSED.slice(0, SIGNS.length + 2)) assert.throws(() => guard({ method, params: [sent] }), `${name} ${method}`);
  }
});

type RefusalClass = typeof MethodNotSupportedRpcError | typeof MethodNotFoundRpcError | typeof InvalidParamsRpcError | typeof InvalidInputRpcError
  | typeof UserRejectedRequestError;
type Answer = RefusalClass | Hash;
/** A wallet behind the signing transport and a real viem 2.56.8 client. `eth` and `wallet` answer each send method in turn (the last
 * answer repeats): a refusal class is thrown, so viem may retry the same transaction through wallet_sendTransaction. */
function viemWallet(eth: Answer[], wallet: Answer[], options: Options & { buyback?: boolean } = {}) {
  const log: string[] = [], counts: Record<string, number> = {};
  let recorded = 0;
  const answer = (answers: Answer[], method: string) => {
    const next = answers[Math.min(counts[method] = (counts[method] ?? -1) + 1, answers.length - 1)];
    if (typeof next === "string") return next;
    throw new next(new Error(`The wallet refused ${method}`));
  };
  const provider = { request: async (request: WalletRequest) => {
    log.push(`wallet:${request.method}`);
    if (request.method === "eth_chainId") return toHex(robinhood.id);
    // A recorded payment must already be on record whenever the wallet receives it.
    if (options.record !== false && !options.buyback) assert.ok(recorded > 0, `recorded before ${request.method}`);
    if (request.method === "eth_sendTransaction") return answer(eth, request.method);
    if (request.method === "wallet_sendTransaction") return answer(wallet, request.method);
    throw new Error(`Unexpected wallet method ${request.method}`);
  } };
  const validate = async () => { log.push("validate"); await options.validate?.(); };
  const request = options.buyback ? buybackRequest(provider, buybackStep, validate) : signingRequest(provider, {
    guardRequest: (request) => { options.guard?.(request); },
    validate,
    ...(options.record === false ? {} : { beforeSend: (resend: boolean) => { recorded++; log.push(`record:${resend}`); } }),
  });
  const client = createWalletClient({ account, chain: robinhood, transport: custom({ request }, { retryCount: 0 }) });
  return { log, send: (input = data) => client.sendTransaction(options.buyback
    ? { to: target, data: input, value: 0n, nonce: 7 } : { to: target, data: input, value: 0n, gas: 21_000n }) };
}
const DEFINITE = [MethodNotSupportedRpcError, MethodNotFoundRpcError, InvalidParamsRpcError];
const FLOWS: [string, Options & { buyback?: boolean }][] = [
  ["recorded (launch, first-buy payment, NFT fee)", { guard: (request) => assertLaunchRequest(request, step) }],
  ["guarded (LI.FI trade, claim, engine action)", { guard: (request) => assertLaunchRequest(request, step), record: false }],
  ["plain (pair and MUSEGOD trades)", { record: false }],
  ["buyback transport", { buyback: true }],
];

test("viem's wallet_sendTransaction fallback after a definite refusal is validated, guarded and recorded", async () => {
  for (const Refusal of DEFINITE) for (const [flow, options] of FLOWS) {
    const wallet = viemWallet([Refusal], [hash], options);
    assert.equal(await wallet.send(), hash);
    const record = options.record !== false && !options.buyback;
    assert.deepEqual(wallet.log, ["wallet:eth_chainId", "validate", ...(record ? ["record:false"] : []), "wallet:eth_sendTransaction",
      "validate", ...(record ? ["record:true"] : []), "wallet:wallet_sendTransaction"], `${flow} ${Refusal.name}`);
  }
});

// The wallet's own InvalidInputRpcError (-32000) is what the caller sees.
const sawInvalidInput = (error: Error & { walk: (fn: (cause: unknown) => boolean) => unknown }) =>
  (error.walk((cause) => (cause as { code?: number }).code === -32000) as { code?: number } | null)?.code === -32000;

test("after an ambiguous wallet error no signer and no buyback resends the transaction; the wallet's own error stands", async () => {
  // InvalidInputRpcError (-32000) is also viem's retry trigger, but a wallet may have broadcast before answering it.
  for (const [flow, options] of FLOWS) {
    const wallet = viemWallet([InvalidInputRpcError], [hash], options);
    await assert.rejects(wallet.send, sawInvalidInput, flow);
    assert.deepEqual(wallets(wallet.log), ["wallet:eth_chainId", "wallet:eth_sendTransaction"], flow);
    assert.equal(wallet.log.filter((entry) => entry === "validate").length, 1, flow);
  }
});

test("on a client that cached wallet_sendTransaction, viem's wallet_ → wallet_ retry follows the same rule", async () => {
  // Only the pair-trade client sends several transactions (approval, Permit2 approval, swap) through one wallet client.
  for (const [flow, options] of FLOWS.filter(([flow]) => flow.startsWith("plain"))) {
    // The first send teaches viem that this client supports wallet_sendTransaction.
    const ambiguous = viemWallet([MethodNotSupportedRpcError], [hash, InvalidInputRpcError], options);
    assert.equal(await ambiguous.send(), hash);
    const before = wallets(ambiguous.log).length;
    // The next transaction goes straight to wallet_sendTransaction; after -32000 viem retries it, and the transport refuses.
    await assert.rejects(() => ambiguous.send(otherData), sawInvalidInput);
    assert.deepEqual(wallets(ambiguous.log).slice(before), ["wallet:eth_chainId", "wallet:wallet_sendTransaction"], `${flow} ambiguous`);
    // After a definite refusal the retry is validated and goes through.
    const definite = viemWallet([MethodNotSupportedRpcError], [hash, InvalidParamsRpcError, hash], options);
    assert.equal(await definite.send(), hash);
    const at = definite.log.length;
    assert.equal(await definite.send(otherData), hash);
    assert.deepEqual(definite.log.slice(at), ["wallet:eth_chainId", "validate", "wallet:wallet_sendTransaction", "validate",
      "wallet:wallet_sendTransaction"], `${flow} definite`);
  }
});

test("a validation refusal on the fallback stops it before the wallet", async () => {
  for (const [flow, options] of FLOWS) {
    let validations = 0;
    const wallet = viemWallet([MethodNotSupportedRpcError], [hash], { ...options,
      validate: () => { if (++validations > 1) throw new Error("The platform configuration changed"); } });
    await assert.rejects(wallet.send, /platform configuration changed/, flow);
    assert.deepEqual(wallets(wallet.log), ["wallet:eth_chainId", "wallet:eth_sendTransaction"], flow);
  }
});

test("a transaction is sent once, and a signer with a record sends only its own transaction", async () => {
  // After the wallet accepted it, the same transaction is never sent again, by either method, with or without a record.
  for (const record of [true, false]) for (const method of SENDS) {
    const { log, request } = harness(undefined, { record });
    await request({ method: "eth_sendTransaction", params: [tx] });
    await assert.rejects(() => request({ method, params: [tx] }), /already sent/);
    assert.deepEqual(wallets(log), ["wallet:eth_sendTransaction"], `record ${record} ${method}`);
  }
  // A signer with a record never sends another transaction, after a success or a refusal.
  for (const answer of [() => hash, () => { throw methodError(-32004, "unsupported"); }]) {
    const { log, request } = harness(answer);
    await request({ method: "eth_sendTransaction", params: [tx] }).catch(() => {});
    await assert.rejects(() => request({ method: "wallet_sendTransaction", params: [{ ...tx, data: otherData }] }), /Only the transaction/);
    assert.deepEqual(log.filter((entry) => entry.startsWith("wallet:") || entry.startsWith("record:")), ["record:false", "wallet:eth_sendTransaction"]);
  }
  // Without a record, approvals and then the swap: each a new transaction, each validated.
  const { log, request } = harness(undefined, { record: false });
  for (const [index, method] of [...SENDS, ...SENDS].entries())
    assert.equal(await request({ method, params: [{ ...tx, nonce: toHex(index) }] }), hash);
  assert.equal(log.filter((entry) => entry === "validate").length, 4);
  assert.equal(wallets(log).length, 4);
});

test("a definite refusal allows the same transaction again, and only a definite one", async () => {
  for (const code of [-32601, -32004, -32602]) {
    const { log, request } = harness((request) => { if (wallets(log).length === 1) throw methodError(code, "refused"); return hash; });
    await assert.rejects(() => request({ method: "eth_sendTransaction", params: [tx] }), /refused/);
    assert.equal(await request({ method: "wallet_sendTransaction", params: [tx] }), hash);
    assert.deepEqual(log.filter((entry) => entry.startsWith("record:")), ["record:false", "record:true"], `${code}`);
  }
  for (const code of [-32000, -32603, 4001, 4900, -1]) {
    const refusal = methodError(code, "ambiguous");
    const { log, request } = harness(() => { throw refusal; }, { record: false });
    await assert.rejects(() => request({ method: "eth_sendTransaction", params: [tx] }));
    await assert.rejects(() => request({ method: "wallet_sendTransaction", params: [tx] }), (error) => error === refusal, `${code}`);
    assert.deepEqual(wallets(log), ["wallet:eth_sendTransaction"], `${code}`);
  }
});

test("walletRefusedUnsent is true only when every send method tried was refused unprocessed", async () => {
  const outcome = async (eth: Answer[], wallet: Answer[], options: Options = {}) => {
    const sent = viemWallet(eth, wallet, options);
    return sent.send().then(() => "sent", (error: unknown) => walletRefusedUnsent(error));
  };
  // eth_ unsupported, then wallet_ unsupported or refusing its parameters: nothing was processed.
  assert.equal(await outcome([MethodNotSupportedRpcError], [MethodNotFoundRpcError]), true);
  assert.equal(await outcome([MethodNotSupportedRpcError], [MethodNotSupportedRpcError]), true);
  assert.equal(await outcome([MethodNotFoundRpcError], [InvalidParamsRpcError]), true);
  // Anything that may have been processed, a user rejection (handled separately), or a refusal of our own.
  assert.equal(await outcome([MethodNotSupportedRpcError], [InvalidInputRpcError]), false);
  assert.equal(await outcome([InvalidInputRpcError], [hash]), false);
  assert.equal(await outcome([UserRejectedRequestError], [hash]), false);
  let validations = 0;
  assert.equal(await outcome([MethodNotSupportedRpcError], [hash], { validate: () => { if (++validations > 1) throw new Error("changed"); } }), false);
  assert.equal(walletRefusedUnsent(methodError(-32601, "missing")), true);
  for (const error of [new Error("plain"), methodError(-32000, "input"), null, undefined, "-32601"]) assert.equal(walletRefusedUnsent(error), false);
});
