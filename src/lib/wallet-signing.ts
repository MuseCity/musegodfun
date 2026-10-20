import { InvalidParamsRpcError, MethodNotFoundRpcError, MethodNotSupportedRpcError } from "viem";
import type { PostOwnerTypedData } from "./token-posts";
/** One EIP-1193 request, as the signing transport and every flow guard see it. */
export type WalletRequest = { method: string; params?: unknown };
/**
 * - `read`: reads and wallet management, passed through unchanged.
 * - `send`: broadcasts one transaction. viem 2.56.8 retries `eth_sendTransaction` as `wallet_sendTransaction` when the wallet
 *   refuses the method or its input, so both are validated, then recorded.
 * - `refuse`: everything else, so an unknown signing or sending method fails closed.
 */
export type WalletMethodClass = "read" | "send" | "refuse";
const READS = ["eth_chainId", "net_version", "eth_accounts", "eth_requestAccounts", "eth_blockNumber", "eth_call", "eth_estimateGas",
  "eth_feeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getLogs",
  "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByHash",
  "wallet_switchEthereumChain", "wallet_addEthereumChain"];
const SENDS = ["eth_sendTransaction", "wallet_sendTransaction"];
// Refused by omission, and used by no flow:
// - `wallet_sendCalls` (a batch) and `eth_sendRawTransaction` (a pre-signed transaction no allowlist can check);
// - every signature: `eth_signTransaction` would hand out a signed payment with no record, and `eth_sign`, `personal_sign` and
//   `eth_signTypedData*` (e.g. a Permit2 permit) can move funds without a transaction this policy sees.
const POLICY: ReadonlyMap<string, Exclude<WalletMethodClass, "refuse">> = new Map([
  ...READS.map((method) => [method, "read"] as const),
  ...SENDS.map((method) => [method, "send"] as const),
]);
export function walletMethodPolicy(method: string): WalletMethodClass {
  return POLICY.get(method) ?? "refuse";
}
export function isTransactionSend(method: string) {
  return walletMethodPolicy(method) === "send";
}
// The wallet refused the send method itself or its parameters, so it never processed the transaction. viem's other retry
// trigger, InvalidInputRpcError (-32000), is a generic error that a wallet may return after broadcasting.
const UNPROCESSED = new Set<number>([MethodNotFoundRpcError.code, MethodNotSupportedRpcError.code, InvalidParamsRpcError.code]);
function rpcCode(error: unknown) {
  for (let cause = error as { code?: unknown; cause?: unknown } | null | undefined, depth = 0; cause && depth < 10; depth++) {
    if (typeof cause.code === "number") return cause.code;
    cause = cause.cause as typeof cause;
  }
  return undefined;
}
/** A send failed with a refusal that proves the wallet processed nothing. The transport never forwards a send after any other
 * refusal of the same transaction, so this holds for every request a signer handed to the wallet for it. */
export function walletRefusedUnsent(error: unknown) {
  const code = rpcCode(error);
  return code !== undefined && UNPROCESSED.has(code);
}
/** Runs right before the wallet receives a send (`resend`: viem's resend of the same request after an unprocessed refusal). It may await,
 * for one to re-verify a cross-tab lease; the wallet request follows it with nothing awaited in between. A throw sends nothing. */
export type BeforeSend = (resend: boolean) => void | Promise<void>;
export type SigningHooks = {
  /** The flow's exact allowlist; it sees every request this policy forwards. */
  guardRequest?: (request: WalletRequest) => void;
  /** The server switch, network and flow checks, rerun before every broadcast. */
  validate: () => Promise<void>;
  /** Records the one transaction this signer may broadcast, after every other check and right before the wallet receives it.
   * `resend`: the same transaction again, after the wallet refused it without processing it (viem's `wallet_sendTransaction`
   * retry). */
  beforeSend?: BeforeSend;
};
type Attempt = { params: string; settled: boolean; refusal?: { error: unknown } };
const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
/** The request read once: a frozen copy for the guard and every check, and `forward()`, a fresh equal copy for the wallet (some
 * providers add fields such as `id` to the request they receive). The caller's object is never forwarded. Malformed requests are
 * refused. */
function snapshot(input: unknown): { request: WalletRequest; params: string; forward: () => WalletRequest } {
  const { method, params } = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as { method?: unknown; params?: unknown };
  if (typeof method !== "string") throw new Error("The wallet request is not allowed");
  if (params === undefined) return { request: Object.freeze({ method }), params: "", forward: () => ({ method }) };
  let serialized: string | undefined;
  try { serialized = JSON.stringify(params); } catch { serialized = undefined; }
  if (typeof serialized !== "string") throw new Error(`The wallet request ${method} is not allowed`);
  const copy = (): WalletRequest => ({ method, params: JSON.parse(serialized) as unknown });
  return { request: deepFreeze(copy()), params: serialized, forward: copy };
}
/** The EIP-1193 `request` of every signing wallet client: the method policy, the flow guard, the resend rule, `validate()` and
 * `beforeSend`, in that order. */
export function signingRequest(provider: { request: (request: WalletRequest) => Promise<unknown> }, { guardRequest, validate, beforeSend }: SigningHooks) {
  // This signer's latest send, reserved before validation so that two sends can never be open at once.
  let last: Attempt | undefined;
  return async (input: unknown) => {
    const { request, params, forward } = snapshot(input), { method } = request, policy = walletMethodPolicy(method);
    if (policy === "refuse") throw new Error(`The wallet request ${method || "(unnamed)"} is not allowed`);
    guardRequest?.(request);
    if (policy === "read") return provider.request(forward());
    const previous = last;
    let resend = false;
    if (previous) {
      if (!previous.settled) throw new Error("A wallet request is already open. Check your wallet before sending again.");
      if (previous.params === params) {
        if (!previous.refusal) throw new Error("This transaction was already sent. Check its saved status.");
        // viem resends a refused transaction (eth_ → wallet_, and wallet_ → wallet_ on a client it cached). It may reach the
        // wallet again only if the wallet processed nothing; otherwise the wallet's own error stands, as if viem had not retried.
        if (!walletRefusedUnsent(previous.refusal.error)) throw previous.refusal.error;
        resend = true;
      } else if (beforeSend) throw new Error("Only the transaction this wallet request recorded can be sent");
    }
    const current: Attempt = last = { params, settled: false };
    try {
      await validate();
      await beforeSend?.(resend);
    } catch (error) {
      last = previous; // Nothing reached the wallet.
      throw error;
    }
    try {
      return await provider.request(forward());
    } catch (error) {
      current.refusal = { error };
      throw error;
    } finally {
      current.settled = true;
    }
  };
}

/** A coin owner's `TokenProfile` typed data (tasks/token-ip-detail-plan.md §5). `expected` is
 * exactly what the editor built; the domain names musegod.fun with no verifying contract, so no token contract can read the signature
 * as an approval. Every other flow keeps refusing every signature (POLICY above). */
export type ProfileSignature = {
  account: string;
  domain: { name: string; version: string; chainId: number };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  /** The message with `issuedAt` as a decimal string, as viem serializes a bigint. */
  message: Record<string, string>;
};
const PROFILE_DOMAIN_TYPES = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }];
/** Sorted-key JSON, so two equal structures compare equal whatever key order a wallet library used. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Throws unless `request` is `eth_signTypedData_v4` for exactly `expected`: the same account, domain, types, primary type and message. */
export function assertProfileSignRequest(request: WalletRequest, expected: ProfileSignature) {
  if (request.method !== "eth_signTypedData_v4") throw new Error(`The wallet request ${request.method || "(unnamed)"} is not allowed`);
  const params = request.params;
  if (!Array.isArray(params) || params.length !== 2 || typeof params[0] !== "string" || params[0].toLowerCase() !== expected.account.toLowerCase())
    throw new Error("The profile signature request does not match the connected account");
  let data: unknown;
  try { data = typeof params[1] === "string" ? JSON.parse(params[1]) : undefined; } catch { data = undefined; }
  const want = { domain: expected.domain, message: expected.message, primaryType: expected.primaryType,
    types: { EIP712Domain: PROFILE_DOMAIN_TYPES, ...expected.types } };
  if (!data || canonical(data) !== canonical(want)) throw new Error("The profile signature request does not match the profile being saved");
}
/** The EIP-1193 `request` of the profile signer: reads pass; one `eth_signTypedData_v4` for exactly `expected` may reach the wallet,
 * after `validate()`; anything else, a second signature included, is refused. */
export function profileSigningRequest(provider: { request: (request: WalletRequest) => Promise<unknown> }, expected: ProfileSignature,
  validate: () => Promise<void>) {
  let state: "ready" | "open" | "used" = "ready";
  return async (input: unknown) => {
    const { request, forward } = snapshot(input), { method } = request;
    if (walletMethodPolicy(method) === "read") return provider.request(forward());
    assertProfileSignRequest(request, expected);
    if (state !== "ready") throw new Error(state === "open" ? "A wallet request is already open. Check your wallet." : "This profile was already signed. Save again to sign once more.");
    state = "open";
    try {
      await validate();
    } catch (error) { state = "ready"; throw error; }
    try { return await provider.request(forward()); } finally { state = "used"; }
  };
}

/** Posts management has its own exact signature capability. It never admits a profile signature, approval or transaction. */
export type PostOwnerSignature = {
  account: string;
  domain: PostOwnerTypedData["domain"];
  types: PostOwnerTypedData["types"];
  primaryType: PostOwnerTypedData["primaryType"];
  message: Omit<PostOwnerTypedData["message"], "issuedAt"> & { issuedAt: string };
};
export function assertPostOwnerSignRequest(request: WalletRequest, expected: PostOwnerSignature) {
  if (request.method !== "eth_signTypedData_v4") throw new Error(`The wallet request ${request.method || "(unnamed)"} is not allowed`);
  const params = request.params;
  if (!Array.isArray(params) || params.length !== 2 || typeof params[0] !== "string" || params[0].toLowerCase() !== expected.account.toLowerCase())
    throw new Error("The Posts signature request does not match the connected account");
  let data: unknown;
  try { data = typeof params[1] === "string" ? JSON.parse(params[1]) : undefined; } catch { data = undefined; }
  const want = { domain: expected.domain, message: expected.message, primaryType: expected.primaryType,
    types: { EIP712Domain: [...PROFILE_DOMAIN_TYPES, { name: "verifyingContract", type: "address" }], ...expected.types } };
  if (!data || canonical(data) !== canonical(want)) throw new Error("The Posts signature request does not match the action being confirmed");
}
export function postOwnerSigningRequest(provider: { request: (request: WalletRequest) => Promise<unknown> }, expected: PostOwnerSignature,
  validate: () => Promise<void>) {
  let state: "ready" | "open" | "used" = "ready";
  return async (input: unknown) => {
    const { request, forward } = snapshot(input);
    if (walletMethodPolicy(request.method) === "read") return provider.request(forward());
    assertPostOwnerSignRequest(request, expected);
    if (state !== "ready") throw new Error(state === "open" ? "A wallet request is already open. Check your wallet." : "This Posts action was already signed. Confirm again to sign once more.");
    state = "open";
    try { await validate(); } catch (error) { state = "ready"; throw error; }
    try { return await provider.request(forward()); } finally { state = "used"; }
  };
}
