import assert from "node:assert/strict";
import test from "node:test";
import { createWalletClient, custom, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { postOwnerTypedData } from "../src/lib/token-posts";
import { profileTypedData, EMPTY_PROFILE_LINKS } from "../src/lib/token-profile";
import { assertPostOwnerSignRequest, postOwnerSigningRequest, walletMethodPolicy, type PostOwnerSignature, type WalletRequest } from "../src/lib/wallet-signing";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const token: Address = "0x2222222222222222222222222222222222222222";
const target = "b8f97d3b-c5e2-4c81-8123-d32fed625e2b";
const data = postOwnerTypedData(4663, token, "create-key", target, "Research Agent", 1_800_000_000_000);
const expected: PostOwnerSignature = { account: account.address, domain: data.domain, types: data.types, primaryType: data.primaryType,
  message: { ...data.message, issuedAt: data.message.issuedAt.toString() } };
function request(change: (value: any) => void = () => {}, signer: string = account.address): WalletRequest {
  const value = { domain: { ...data.domain }, message: { ...expected.message }, primaryType: data.primaryType,
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" }], ...data.types } };
  change(value);
  return { method: "eth_signTypedData_v4", params: [signer, JSON.stringify(value)] };
}

test("Posts signer admits exactly one real viem owner action while the shared wallet policy still refuses signatures", async () => {
  assert.equal(walletMethodPolicy("eth_signTypedData_v4"), "refuse");
  const seen: WalletRequest[] = [];
  let checks = 0;
  const provider = { request: async (input: WalletRequest) => { seen.push(input); return input.method === "eth_chainId" ? "0x1237" : account.signTypedData(data); } };
  const guarded = postOwnerSigningRequest(provider, expected, async () => { checks++; });
  const client = createWalletClient({ account: account.address, chain: robinhood, transport: custom({ request: guarded }, { retryCount: 0 }) });
  assert.equal(await client.signTypedData(data), await account.signTypedData(data));
  assert.equal(checks, 1);
  assert.deepEqual(seen.filter((entry) => entry.method !== "eth_chainId").map((entry) => entry.method), ["eth_signTypedData_v4"]);
  await assert.rejects(client.signTypedData(data), /already signed/);
});

test("Posts signing guard binds account, token, chain, action, target, name, fixed lifetime and timestamp", () => {
  assert.doesNotThrow(() => assertPostOwnerSignRequest(request(), expected));
  for (const [label, changed] of [
    ["another account", request(() => {}, token)],
    ["another token", request((value) => { value.domain.verifyingContract = account.address; })],
    ["another chain", request((value) => { value.domain.chainId = 8453; })],
    ["another domain", request((value) => { value.domain.name = "Musegod Token Profile"; })],
    ["another action", request((value) => { value.message.action = "delete-post"; })],
    ["another target", request((value) => { value.message.targetId = crypto.randomUUID(); })],
    ["another name", request((value) => { value.message.name = "Other Agent"; })],
    ["another lifetime", request((value) => { value.message.keyLifetimeDays = 365; })],
    ["another timestamp", request((value) => { value.message.issuedAt = "1"; })],
    ["another primary type", request((value) => { value.primaryType = "Permit"; })],
    ["extra message", request((value) => { value.message.spender = account.address; })],
    ["extra type", request((value) => { value.types.Permit = [{ name: "value", type: "uint256" }]; })],
  ] as const) assert.throws(() => assertPostOwnerSignRequest(changed, expected), /does not match/, label);
});

test("Posts signer refuses profile signatures, every transaction and unknown signing methods before forwarding", async () => {
  let forwarded = 0;
  const guarded = postOwnerSigningRequest({ request: async () => { forwarded++; return "0x"; } }, expected, async () => {});
  const profile = profileTypedData(4663, token, EMPTY_PROFILE_LINKS, Number(data.message.issuedAt));
  const profileRequest = { method: "eth_signTypedData_v4", params: [account.address, JSON.stringify({ ...profile, message: { ...profile.message, issuedAt: profile.message.issuedAt.toString() } })] };
  await assert.rejects(guarded(profileRequest), /does not match/);
  for (const method of ["eth_sendTransaction", "wallet_sendTransaction", "eth_sendRawTransaction", "wallet_sendCalls", "personal_sign", "eth_sign", "eth_signTypedData_v3"])
    await assert.rejects(guarded({ method, params: [] }), /not allowed/, method);
  assert.equal(forwarded, 0);
});

test("Posts signing snapshots the request, excludes concurrent signatures and can retry a validation that forwarded nothing", async () => {
  let release!: () => void, checks = 0;
  const seen: WalletRequest[] = [], input = request();
  const guarded = postOwnerSigningRequest({ request: async (value) => { seen.push(value); return "0x1234"; } }, expected, async () => {
    if (++checks === 1) throw new Error("Wallet changed");
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await assert.rejects(guarded(input), /Wallet changed/); assert.equal(seen.length, 0);
  const pending = guarded(input);
  await assert.rejects(guarded(request()), /already open/);
  (input.params as string[])[1] = "{}";
  release(); await pending;
  assert.equal(seen.length, 1); assertPostOwnerSignRequest(seen[0], expected);
  await assert.rejects(guarded(request()), /already signed/);
});
