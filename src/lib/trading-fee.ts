export const TRADING_FEE_BPS = [100, 125, 150, 175, 200, 225, 250, 275, 300] as const;
export const DEFAULT_TRADING_FEE_BPS = 100;
export const LP_FEE_PPM = 500;

export function tradingFeeBpsFor(value?: number): number {
  if (value === undefined) return DEFAULT_TRADING_FEE_BPS;
  if (!Number.isInteger(value) || !TRADING_FEE_BPS.some((fee) => fee === value))
    throw new Error("Trading fee must be one of the supported rates between 1% and 3%");
  return value;
}
