import { InvalidParamsRpcError, MethodNotFoundRpcError, MethodNotSupportedRpcError } from "viem";
/** One EIP-1193 request, as the signing transport and every flow guard see it. */
export type WalletRequest = { method: string; params?: unknown };
/**
 * - `read`: reads and wallet management, passed through unchanged.
 * - `send`: broadcasts one transaction. viem 2.56.8 retries `eth_sendTransaction` as `wallet_sendTransaction` when the wallet
 *   refuses the method or its input, so both are validated, then recorded.
 * - `sign`: signs without broadcasting, validated.
 * - `refuse`: everything else, so an unknown signing or sending method fails closed.
 */
export type WalletMethodClass = "read" | "send" | "sign" | "refuse";
const READS = ["eth_chainId", "net_version", "eth_accounts", "eth_requestAccounts", "eth_blockNumber", "eth_call", "eth_estimateGas",
  "eth_feeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getLogs",
  "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByHash",
  "wallet_switchEthereumChain", "wallet_addEthereumChain"];
const SENDS = ["eth_sendTransaction", "wallet_sendTransaction"];
const SIGNS = ["eth_signTransaction", "eth_sign", "personal_sign", "eth_signTypedData", "eth_signTypedData_v1", "eth_signTypedData_v3",
  "eth_signTypedData_v4"];
// Refused by omission: `wallet_sendCalls` (no flow sends a batch) and `eth_sendRawTransaction` (a pre-signed transaction cannot be
// checked against any flow's allowlist; no flow sends one through the wallet).
const POLICY: ReadonlyMap<string, Exclude<WalletMethodClass, "refuse">> = new Map([
  ...READS.map((method) => [method, "read"] as const),
  ...SENDS.map((method) => [method, "send"] as const),
  ...SIGNS.map((method) => [method, "sign"] as const),
]);
export function walletMethodPolicy(method: string): WalletMethodClass {
  return POLICY.get(method) ?? "refuse";
}
export function isTransactionSend(method: string) {
  return walletMethodPolicy(method) === "send";
}
// The wallet refused `eth_sendTransaction` itself or its parameters, so it never processed the transaction. viem's other fallback
// trigger, InvalidInputRpcError (-32000), is a generic error that a wallet may return after broadcasting.
const UNPROCESSED = new Set<number>([MethodNotFoundRpcError.code, MethodNotSupportedRpcError.code, InvalidParamsRpcError.code]);
export type SigningHooks = {
  /** The flow's exact allowlist; it sees every request this policy forwards. */
  guardRequest?: (request: WalletRequest) => void;
  /** The server switch, network and flow checks, rerun before every broadcast or signature. */
  validate: () => Promise<void>;
  /** Records the one transaction this signer may broadcast, after every other check and right before the wallet receives it.
   * `resend`: viem is resending that same transaction through `wallet_sendTransaction` because the wallet refused
   * `eth_sendTransaction` without processing it. */
  beforeSend?: (resend: boolean) => void;
};
type Attempt = { method: string; params: string; settled: boolean; refusal?: { error: unknown } };
/** The EIP-1193 `request` of every signing wallet client: the method policy, then the flow guard, `validate()` and `beforeSend`. */
export function signingRequest(provider: { request: (request: WalletRequest) => Promise<unknown> }, { guardRequest, validate, beforeSend }: SigningHooks) {
  // A signer with a record broadcasts exactly one transaction: this is its latest attempt.
  let attempt: Attempt | undefined;
  return async (request: WalletRequest) => {
    const { method } = request, policy = walletMethodPolicy(method);
    if (policy === "refuse") throw new Error(`The wallet request ${method || "(unnamed)"} is not allowed`);
    guardRequest?.(request);
    if (policy === "read") return provider.request(request);
    const recorded = policy === "send" && !!beforeSend, params = recorded ? JSON.stringify(request.params) : "";
    let resend = false;
    if (recorded && attempt) {
      const refused = attempt.refusal;
      if (!attempt.settled || !refused) throw new Error("This wallet request was already sent. Check its saved status.");
      if (attempt.method !== "eth_sendTransaction" || method !== "wallet_sendTransaction" || attempt.params !== params)
        throw new Error("Only the transaction this wallet request recorded can be sent");
      // The wallet may have broadcast before answering: its own error stands, as if viem had not retried.
      const code = (refused.error as { code?: unknown } | null | undefined)?.code;
      if (typeof code !== "number" || !UNPROCESSED.has(code)) throw refused.error;
      resend = true;
    }
    await validate();
    if (!recorded) return provider.request(request);
    beforeSend!(resend);
    const current: Attempt = attempt = { method, params, settled: false };
    try {
      return await provider.request(request);
    } catch (error) {
      current.refusal = { error };
      throw error;
    } finally {
      current.settled = true;
    }
  };
}
