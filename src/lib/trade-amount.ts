import { parseEther } from "viem";

type GasFees = { maxFeePerGas?: bigint; gasPrice?: bigint };
export function ethGasReserve(fees?: GasFees) {
  const price = fees?.maxFeePerGas ?? fees?.gasPrice;
  if (price === undefined || price < 0n) throw new Error("The current network fee estimate is unavailable. Try Max again.");
  const reserve = 2n * 500_000n * price, floor = parseEther("0.0002");
  return reserve > floor ? reserve : floor;
}
export function maxTradeAmount(balance: bigint, payingEth: boolean, fees?: GasFees) {
  if (!payingEth) return balance;
  const reserve = ethGasReserve(fees);
  return balance > reserve ? balance - reserve : null;
}
