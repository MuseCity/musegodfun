import { formatUnits } from "viem";
function usdPrice(value: string) {
  if (!/^(?:0|[1-9]\d{0,20})(?:\.\d{1,36})?$/.test(value)) throw new Error("The payment USD price is unavailable.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole + fraction);
  if (!amount) throw new Error("The payment USD price is unavailable.");
  return { amount, scale: 10n ** BigInt(fraction.length) };
}
export function usdFirstBuyAmount(dollars: number, price: string, decimals: number) {
  if (![10, 20, 50, 100].includes(dollars) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("Unsupported payment shortcut.");
  const quote = usdPrice(price), raw = BigInt(dollars) * quote.scale * 10n ** BigInt(decimals) / quote.amount;
  if (raw <= 0n || raw >= 2n ** 128n) throw new Error("The shortcut amount is outside the supported range.");
  return formatUnits(raw, decimals);
}
export function firstBuyUsdReference(raw: bigint, price: string, decimals: number) {
  const quote = usdPrice(price);
  return formatUnits(raw * quote.amount * 1_000_000n / (10n ** BigInt(decimals) * quote.scale), 6);
}
