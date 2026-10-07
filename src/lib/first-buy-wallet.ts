import { quoteNow } from "./quote-clock";
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Address, type Hash } from "viem";
import { deploymentChain, launchAssetsFor, sameAddress, type RuntimeConfig } from "./config";
import { assertSigningEnabled, validTreasury } from "./validation";
import { assertFirstBuyPaymentQuote, firstBuyPaymentAbi, type FirstBuyPaymentQuote } from "./first-buy-payment";
import type { LaunchTransaction } from "./launch-plan";
import { CURVE_POLICY } from "./launch-curve";
import { ENGINE_FEE_POLICY, FEE_POLICY, launchFeePolicy } from "./fee-policy";

/** A payment must stop if the following launch has already become unavailable
 * or differs from the configuration the creator reviewed. Receipt recovery
 * deliberately does not use this signing-only check. */
export function assertFirstBuyLaunchConfig(frozen: RuntimeConfig, current: RuntimeConfig) {
  assertSigningEnabled(frozen);
  assertSigningEnabled(current);
  const changedAddress = (["treasury", "launchGuard", "feeEngine", "automationReceiver", "automationTreasury", "wethForwarder"] as const)
    .some((key) => frozen[key] && current[key] ? !sameAddress(frozen[key], current[key]) : (frozen[key] ?? null) !== (current[key] ?? null));
  if (frozen.chainId !== current.chainId || frozen.mode !== current.mode || deploymentChain(frozen) !== deploymentChain(current) ||
    !validTreasury(frozen.launchGuard || undefined) || !validTreasury(current.launchGuard || undefined) || changedAddress ||
    frozen.curvePolicy !== CURVE_POLICY || current.curvePolicy !== CURVE_POLICY ||
    (frozen.launchLockAvailable === true) !== (current.launchLockAvailable === true) ||
    (frozen.feePolicy ?? FEE_POLICY) !== (current.feePolicy ?? FEE_POLICY) || launchFeePolicy(frozen) !== launchFeePolicy(current))
    throw new Error("The launch configuration changed or the first buy is unavailable. Refresh and preview again before paying.");
  if (launchFeePolicy(current) === ENGINE_FEE_POLICY && (!validTreasury(current.feeEngine || undefined) ||
    [current.treasury, current.automationReceiver, current.automationTreasury, current.wethForwarder].some((address) => !validTreasury(address || undefined)) ||
    new Set([current.treasury, current.automationReceiver, current.automationTreasury, current.wethForwarder].map((address) => address?.toLowerCase())).size !== 4))
    throw new Error("The launch fee engine is unavailable. Refresh and preview again before paying.");
}

type PaymentDependencies = {
  validate: (quote: FirstBuyPaymentQuote) => Promise<void>;
  balance: (token: Address) => Promise<bigint>;
  allowance: (token: Address, spender: Address) => Promise<bigint>;
  approve: (transaction: LaunchTransaction, quote: FirstBuyPaymentQuote) => Promise<void>;
  simulate: (quote: FirstBuyPaymentQuote) => Promise<bigint>;
  submit: (quote: FirstBuyPaymentQuote, gas: bigint) => Promise<Hash>;
  progress: (message: string) => void;
  refresh?: (previous: FirstBuyPaymentQuote) => Promise<FirstBuyPaymentQuote>;
  onQuote?: (quote: FirstBuyPaymentQuote) => void;
};
export async function executeFirstBuyPayment(quote: FirstBuyPaymentQuote, config: RuntimeConfig, account: Address, deps: PaymentDependencies) {
  let frozen = structuredClone(quote);
  const acceptedMinimum = BigInt(quote.minimumOut);
  const refresh = async () => {
    if (!deps.refresh) return;
    const next = structuredClone(await deps.refresh(frozen));
    if (next.chainId !== quote.chainId || next.account !== quote.account || next.fromToken.address !== quote.fromToken.address ||
      next.toToken.address !== quote.toToken.address || next.amountIn !== quote.amountIn || next.router !== quote.router || next.protocol !== quote.protocol)
      throw new Error("The payment changed. Review it before continuing.");
    if (BigInt(next.expectedOut) < acceptedMinimum) throw new PaymentPriceChanged(next);
    if (next.protocol === "lifi" && BigInt(next.minimumOut) < acceptedMinimum) {
      const decoded = decodeFunctionData({ abi: firstBuyPaymentAbi, data: next.transaction.data });
      const args = [...decoded.args]; args[4] = acceptedMinimum;
      next.minimumOut = acceptedMinimum.toString();
      next.transaction.data = encodeFunctionData({ abi: firstBuyPaymentAbi, functionName: decoded.functionName, args: args as never });
    }
    assertFirstBuyPaymentQuote(next); frozen = next; deps.onQuote?.(frozen);
  };
  const launchConfig = Object.freeze({ ...config });
  const validate = async () => {
    assertFirstBuyLaunchConfig(launchConfig, config);
    assertFirstBuyPaymentQuote(frozen);
    if (frozen.chainId !== deploymentChain(config) || !sameAddress(frozen.account, account))
      throw new Error("The payment quote belongs to another network or wallet. Preview again.");
    if (!launchAssetsFor(config).some((asset) => sameAddress(asset.address, frozen.toToken.address)))
      throw new Error("This asset is unavailable for a new launch because it is not in the verified LI.FI opening-price pairing list.");
    await deps.validate(frozen);
  };
  if (deps.refresh && frozen.expiresAt - quoteNow(frozen) < 15_000) await refresh();
  await validate();
  const amount = BigInt(frozen.amountIn);
  if (await deps.balance(frozen.fromToken.address) < amount) throw new Error("Insufficient available payment balance");
  if (frozen.approval) {
    const { token, spender } = frozen.approval;
    const allowance = await deps.allowance(token, spender);
    if (allowance !== amount) {
      const approve = async (value: bigint) => {
        await validate();
        await deps.approve({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, value] }), value: "0" }, frozen);
        if (deps.refresh) await refresh();
      };
      if (allowance > 0n) { deps.progress("Reset the payment router approval"); await approve(0n); }
      deps.progress("Approve this payment amount only");
      await approve(amount);
    }
  }
  if (deps.refresh && frozen.expiresAt - quoteNow(frozen) < 15_000) await refresh();
  await validate();
  const gas = await deps.simulate(frozen);
  await validate();
  deps.progress("Confirm the payment conversion in your wallet");
  return deps.submit(frozen, gas);
}

export class PaymentPriceChanged extends Error {
  constructor(public quote: FirstBuyPaymentQuote) { super("The payment price changed beyond your accepted minimum. Review the updated amount; your approval is saved."); }
}
