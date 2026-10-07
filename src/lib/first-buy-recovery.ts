import { quoteNow } from "./quote-clock";
import type { Address, Hex } from "viem";
import { deploymentChain, sameAddress, type RuntimeConfig, type TokenRecord } from "./config";
import { assertFirstBuyPaymentQuote, firstBuyInteger, type FirstBuyPaymentQuote, type FirstBuyPaymentVerification } from "./first-buy-payment";
import type { LaunchPlan } from "./launch-plan";
import { transactionMatchesConfig, type Transaction } from "./transactions";

export type FirstBuyPaymentAttempt = { quote: FirstBuyPaymentQuote; hash: Hex; actualOutput: string | null; launchHash?: Hex; intentId?: string };
const hashPattern = /^0x[\da-f]{64}$/i;
export function sameFirstBuyPayment(left: FirstBuyPaymentAttempt, right: FirstBuyPaymentAttempt): boolean {
  try {
    assertFirstBuyPaymentQuote(left.quote, quoteNow(left.quote), true);
    assertFirstBuyPaymentQuote(right.quote, quoteNow(right.quote), true);
    return hashPattern.test(left.hash) && sameAddress(left.hash, right.hash) && left.actualOutput === right.actualOutput &&
      left.quote.chainId === right.quote.chainId && sameAddress(left.quote.account, right.quote.account) &&
      sameAddress(left.quote.transactionId, right.quote.transactionId) && sameAddress(left.quote.transaction.to, right.quote.transaction.to) &&
      left.quote.transaction.data.toLowerCase() === right.quote.transaction.data.toLowerCase() && left.quote.transaction.value === right.quote.transaction.value &&
      sameAddress(left.quote.fromToken.address, right.quote.fromToken.address) && sameAddress(left.quote.toToken.address, right.quote.toToken.address) &&
      left.quote.amountIn === right.quote.amountIn;
  } catch { return false; }
}
/** A launch may bind this payment only when it spends the verified output
 * exactly. A separately funded launch must leave the recovery record alone. */
export function paymentMatchesLaunch(payment: FirstBuyPaymentAttempt, plan: LaunchPlan): boolean {
  try {
    assertFirstBuyPaymentQuote(payment.quote, quoteNow(payment.quote), true);
    firstBuyInteger(payment.actualOutput);
    return hashPattern.test(payment.hash) && (!payment.intentId || !plan.intentId || payment.intentId === plan.intentId) && !!plan.firstBuy &&
      plan.openingValuation?.chainId === payment.quote.chainId && sameAddress(plan.creator, payment.quote.account) &&
      sameAddress(plan.firstBuy.recipient, payment.quote.account) &&
      sameAddress(plan.draft.quoteAddress, payment.quote.toToken.address) &&
      sameAddress(plan.firstBuy.quoteAddress, payment.quote.toToken.address) && plan.firstBuy.amountIn === payment.actualOutput;
  } catch { return false; }
}
/** Clearing a payment requires its own canonical proof and the exact launch
 * marker saved at submission. Registration of an unrelated token is insufficient. */
export function registeredLaunchConsumesPayment(payment: FirstBuyPaymentAttempt, token: TokenRecord, hash: Hex,
  verification: FirstBuyPaymentVerification): boolean {
  try {
    assertFirstBuyPaymentQuote(payment.quote, quoteNow(payment.quote), true);
    firstBuyInteger(payment.actualOutput);
    return hashPattern.test(payment.hash) && hashPattern.test(hash) && typeof payment.launchHash === "string" && hashPattern.test(payment.launchHash) &&
      sameAddress(payment.launchHash, hash) && !!token.transactionHash && sameAddress(token.transactionHash, hash) &&
      !!token.creator && sameAddress(token.creator, payment.quote.account) && sameAddress(token.quoteAddress, payment.quote.toToken.address) &&
      deploymentChain(token) === payment.quote.chainId && verification.status === "success" &&
      sameAddress(verification.hash, payment.hash) && verification.actualOutput === payment.actualOutput &&
      typeof verification.blockNumber === "string" && /^[1-9]\d*$/.test(verification.blockNumber) &&
      typeof verification.blockHash === "string" && hashPattern.test(verification.blockHash);
  } catch { return false; }
}

export type FirstBuyRecoveryDependencies = {
  receipt: (hash: Hex) => Promise<{ status: "success" | "reverted"; from: Address; blockNumber: bigint; blockHash: Hex; transactionHash?: Hex }>;
  transaction: (hash: Hex) => Promise<{ from: Address; to: Address | null; input: Hex; value: bigint; nonce: number; hash?: Hex }>;
  head: () => Promise<bigint>;
  block: (blockNumber: bigint) => Promise<{ hash: Hex | null }>;
};
function matchesQuote(tx: { from: Address; to: Address | null; input: Hex; value: bigint }, q: FirstBuyPaymentQuote) {
  return sameAddress(tx.from, q.account) && !!tx.to && sameAddress(tx.to, q.transaction.to) &&
    tx.input.toLowerCase() === q.transaction.data.toLowerCase() && tx.value === BigInt(q.transaction.value);
}
/** Resolve recorded nonce replacements using canonical chain evidence. This
 * reader never broadcasts, retries a conversion, or accepts changed-tx output. */
export async function resolveFirstBuyPayment(hash: Hex, quote: FirstBuyPaymentQuote, rows: Transaction[],
  config: RuntimeConfig, deps: FirstBuyRecoveryDependencies): Promise<{ hash: Hex; cancelled: boolean }> {
  assertFirstBuyPaymentQuote(quote, quoteNow(quote), true);
  if (!/^0x[\da-f]{64}$/i.test(hash) || quote.chainId !== deploymentChain(config))
    throw new Error("The payment recovery belongs to another network.");
  const rowFor = (candidate: Hex) => rows.find((row) => row.hash.toLowerCase() === candidate.toLowerCase() &&
    row.action === "swap" && transactionMatchesConfig(row, config) && sameAddress(row.account, quote.account) &&
    typeof row.firstBuyPayment?.transaction?.data === "string" &&
    row.firstBuyPayment.transaction.data.toLowerCase() === quote.transaction.data.toLowerCase() &&
    row.firstBuyPayment.transaction.value === quote.transaction.value &&
    typeof row.firstBuyPayment.transactionId === "string" &&
    row.firstBuyPayment.transactionId.toLowerCase() === quote.transactionId.toLowerCase());
  const original = rowFor(hash);
  let nonce = Number.isSafeInteger(original?.nonce) && original!.nonce! >= 0 ? original!.nonce : undefined;
  let current = hash;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current.toLowerCase())) return { hash, cancelled: false };
    seen.add(current.toLowerCase());
    const row = rowFor(current);
    if (!row?.replacement || !["cancelled", "replaced"].includes(row.status)) break;
    if (!/^0x[\da-f]{64}$/i.test(row.replacement)) return { hash, cancelled: false };
    current = row.replacement;
  }
  if (current.toLowerCase() === hash.toLowerCase()) return { hash, cancelled: false };
  // Prefer the original transaction's exact data over persisted metadata when
  // the old hash is still available; never infer a nonce from another payment.
  try {
    const originalTx = await deps.transaction(hash);
    if (!matchesQuote(originalTx, quote) || (originalTx.hash && originalTx.hash.toLowerCase() !== hash.toLowerCase()) ||
      !Number.isSafeInteger(originalTx.nonce) || originalTx.nonce < 0) return { hash, cancelled: false };
    nonce = originalTx.nonce;
  } catch { /* An evicted old hash can still have a nonce captured when sent. */ }
  if (nonce === undefined) return { hash, cancelled: false };
  try {
    const tx = await deps.transaction(current);
    if (!sameAddress(tx.from, quote.account) || tx.nonce !== nonce ||
      (tx.hash && tx.hash.toLowerCase() !== current.toLowerCase())) return { hash, cancelled: false };
    if (matchesQuote(tx, quote)) return { hash: current, cancelled: false };
    const receipt = await deps.receipt(current);
    const [head, block] = await Promise.all([deps.head(), deps.block(receipt.blockNumber)]);
    if (!sameAddress(receipt.from, quote.account) || (receipt.transactionHash && receipt.transactionHash.toLowerCase() !== current.toLowerCase()) ||
      !["success", "reverted"].includes(receipt.status) || block.hash !== receipt.blockHash || head < receipt.blockNumber + 1n)
      return { hash, cancelled: false };
    return { hash: current, cancelled: true };
  } catch { return { hash, cancelled: false }; }
}
