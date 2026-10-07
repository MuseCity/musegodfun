import { airlockAbi, bundlerAbi, computePoolId } from "@whetstone-research/doppler-sdk/evm";
import { decodeEventLog, encodeFunctionData, erc20Abi, keccak256, type TransactionReceipt } from "viem";
import { CONTRACTS, ROBINHOOD_BUNDLER, sameAddress, type ContractRegistry } from "../src/lib/config";
import { CURVE_POLICY } from "../src/lib/launch-curve";
import { launchGuardAbi } from "../src/lib/launch-guard";
import { restorePrepared, type FirstBuyLockRecord, type LaunchPlan } from "../src/lib/launch-plan";
import { minimumOutput, parseAmount } from "../src/lib/validation";
import { stockByAddress } from "../src/lib/config";
import { assertEngineFeeCalldata } from "../src/lib/protocol";

export function assertPlanIntegrity(plan: LaunchPlan, contracts: ContractRegistry) {
  if (!plan.prepared || !plan.transaction || plan.curvePolicy !== CURVE_POLICY)
    throw new Error("The frozen issuance preview is missing. Run a new preview.");
  const p = restorePrepared(plan.prepared), buy = plan.firstBuy;
  assertEngineFeeCalldata(plan, p.createParams.poolInitializerData);
  if (p.chainId !== (sameAddress(contracts.airlock, CONTRACTS.airlock) ? 8453 : 4663) ||
    !sameAddress(p.airlock, contracts.airlock) || !sameAddress(p.account, plan.creator) ||
    !sameAddress(p.createParams.numeraire, plan.draft.quoteAddress) ||
    !sameAddress(p.prediction.tokenAddress, plan.tokenAddress) || p.prediction.poolId !== plan.poolId ||
    computePoolId(p.prediction.poolKey) !== plan.poolId ||
    !sameAddress(p.transaction.to, plan.transaction.to) || p.transaction.data !== plan.data ||
    plan.transaction.data !== plan.data || p.transaction.value !== 0n || plan.transaction.value !== "0" ||
    keccak256(plan.data) !== plan.id)
    throw new Error("The frozen issuance parameters changed. Run a new preview.");
  let data;
  if (buy) {
    const lockDays = buy.lockDays ?? 0;
    const duration = BigInt(lockDays) * 86400n;
    if (!p.devBuy || !plan.approval || !sameAddress(buy.guard, p.transaction.to) ||
      !sameAddress(buy.bundler, ROBINHOOD_BUNDLER) || !sameAddress(p.devBuy.bundler, ROBINHOOD_BUNDLER) ||
      !sameAddress(buy.recipient, plan.creator) || !sameAddress(p.devBuy.recipient, plan.creator) ||
      !sameAddress(buy.quoteAddress, plan.draft.quoteAddress) ||
      p.devBuy.exactAmountIn !== BigInt(buy.amountIn) || p.devBuy.simulatedAmountOut !== BigInt(buy.expectedAmountOut) ||
      ![0, 30, 90, 365].includes(lockDays) ||
      p.devBuy.vesting.cliffDuration !== duration || p.devBuy.vesting.vestingDuration !== duration || p.devBuy.vesting.permissionlessClaim ||
      parseAmount(buy.amount, stockByAddress(buy.quoteAddress).decimals) !== BigInt(buy.amountIn) ||
      minimumOutput(BigInt(buy.expectedAmountOut), buy.slippageBps) !== BigInt(buy.minAmountOut) ||
      !plan.openingValuation || buy.deadline !== Math.floor(plan.openingValuation.expiresAt / 1000))
      throw new Error("The frozen first buy parameters changed. Run a new preview.");
    data = lockDays > 0 ? encodeFunctionData({ abi: launchGuardAbi, functionName: "createAndBuyLocked",
      args: [p.createParams, BigInt(buy.amountIn), BigInt(buy.minAmountOut), BigInt(buy.deadline), lockDays] })
      : encodeFunctionData({ abi: launchGuardAbi, functionName: "createAndBuy",
        args: [p.createParams, BigInt(buy.amountIn), BigInt(buy.minAmountOut), BigInt(buy.deadline)] });
    const approval = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [buy.guard, BigInt(buy.amountIn)] });
    if (!sameAddress(plan.approval.token, buy.quoteAddress) || !sameAddress(plan.approval.spender, buy.guard) ||
      plan.approval.amount !== buy.amountIn || plan.approval.transaction.data !== approval ||
      !sameAddress(plan.approval.transaction.to, buy.quoteAddress) || plan.approval.transaction.value !== "0" ||
      !p.approvalTransaction || p.approvalTransaction.data !== approval ||
      !sameAddress(p.approvalTransaction.to, buy.quoteAddress) || p.approvalTransaction.value !== 0n)
      throw new Error("The frozen first buy approval changed. Run a new preview.");
  } else {
    if (p.devBuy || plan.approval || !sameAddress(p.transaction.to, contracts.airlock))
      throw new Error("The issuance target changed. Run a new preview.");
    data = encodeFunctionData({ abi: airlockAbi, functionName: "create", args: [p.createParams] });
  }
  if (data !== plan.data) throw new Error("The frozen issuance calldata changed. Run a new preview.");
}

export function verifyGuardedReceipt(plan: LaunchPlan, receipt: TransactionReceipt, bundledAmountOut?: bigint) {
  const buy = plan.firstBuy;
  if (!buy || bundledAmountOut === undefined) throw new Error("The verified Bundler first buy event is missing.");
  const events = receipt.logs.filter((log) => sameAddress(log.address, buy.guard)).flatMap((log) => {
    try {
      const event = decodeEventLog({ abi: launchGuardAbi, data: log.data, topics: log.topics, strict: true });
      return event.eventName === "GuardedLaunch" ? [event.args] : [];
    } catch { return []; }
  });
  const e = events[0];
  if (events.length !== 1 || !sameAddress(e.creator, plan.creator) || !sameAddress(e.asset, plan.tokenAddress) ||
    !sameAddress(e.numeraire, buy.quoteAddress) || e.amountIn !== BigInt(buy.amountIn) ||
    e.minAmountOut !== BigInt(buy.minAmountOut) || e.deadline !== BigInt(buy.deadline) || e.poolId !== plan.poolId ||
    e.amountOut !== bundledAmountOut || e.amountOut < e.minAmountOut)
    throw new Error("The launch guard event does not match the protected first buy preview.");
  return e;
}

export function verifiedFirstBuyLock(plan: LaunchPlan, receipt: TransactionReceipt, blockTimestamp: bigint): FirstBuyLockRecord | undefined {
  const buy = plan.firstBuy;
  if (!buy || !buy.lockDays) return undefined;
  const duration = BigInt(buy.lockDays) * 86400n;
  const events = receipt.logs.filter((log) => sameAddress(log.address, buy.bundler)).flatMap((log) => {
    try {
      const event = decodeEventLog({ abi: bundlerAbi, data: log.data, topics: log.topics, strict: true });
      return event.eventName === "VestingCreated" ? [event.args] : [];
    } catch { return []; }
  });
  const event = events[0];
  if (events.length !== 1 || !sameAddress(event.asset, plan.tokenAddress) || !sameAddress(event.recipient, plan.creator) ||
    event.permissionlessClaim || event.cliffDuration !== duration || event.vestingDuration !== duration ||
    event.start !== blockTimestamp || event.totalAmount < BigInt(buy.minAmountOut) ||
    event.totalAmount !== verifyGuardedReceipt(plan, receipt, event.totalAmount).amountOut)
    throw new Error("The first buy lock event does not match the frozen schedule or receipt block.");
  return { bundler: buy.bundler, recipient: event.recipient, totalAmount: String(event.totalAmount), start: Number(event.start),
    cliffDuration: Number(event.cliffDuration), vestingDuration: Number(event.vestingDuration), lockDays: buy.lockDays };
}
