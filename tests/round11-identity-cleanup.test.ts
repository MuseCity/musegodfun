import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, keccak256, stringToHex } from "viem";
import { base } from "viem/chains";
import { contractIdentityOnce, type ContractIdentityStore } from "../server/contract-identity";
import { alchemyRpcTransport } from "../server/alchemy-rpc";
import * as activation from "../server/base-activation-record";

test("private immutable seals use deterministic key ordering rather than locale collation", async () => {
  let row: any;
  const store: ContractIdentityStore = { getBuybackBatch: async () => null,
    compareAndSetBuybackAudit: async next => { row = next; return true; } };
  await contractIdentityOnce({}, { namespace: "round11_order", store,
    binding: { a: 1, Z: 2, _: 3, "é": 4 }, validate: () => true,
    verify: async () => ({ a: 1, Z: 2, _: 3, "é": 4 }) });
  // Independent canonical golden strings distinguish uppercase, punctuation
  // and non-ASCII names from ICU locale-dependent ordering.
  const expected = keccak256(stringToHex('{"identity":{"Z":2,"_":3,"a":1,"é":4},"namespace":"round11_order"}'));
  assert.equal(row.id, `internal_native_contract_identity_v1:${expected}`);
  assert.equal(row.valueHash, keccak256(stringToHex('{"Z":2,"_":3,"a":1,"é":4}')));
});

test("the retired per-read activation anchor verifier has no remaining runtime export", () => {
  assert.equal("assertBaseActivationRecord" in activation, false);
  assert.equal(typeof activation.hasBaseLaunchActivationRecord, "function");
  assert.equal(typeof activation.persistBaseActivationRecord, "function");
});

test("Alchemy transport preserves the native global fetch receiver", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", function (this: unknown, _input: any, init?: RequestInit) {
    assert.equal(this, globalThis); calls++;
    const body = JSON.parse(String(init?.body)), rows = Array.isArray(body) ? body : [body];
    const answers = rows.map((entry: any) => ({ jsonrpc: "2.0", id: entry.id, result: "0x2105" }));
    return Promise.resolve(Response.json(Array.isArray(body) ? answers : answers[0]));
  });
  const client = createPublicClient({ chain: base, transport: alchemyRpcTransport(8453, { ALCHEMY_API_KEY: "offline" }) });
  assert.equal(await client.getChainId(), 8453); assert.equal(calls, 1);
});
