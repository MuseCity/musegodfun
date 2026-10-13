import { getAddress, type Address, type Hex } from "viem";
import type { NftChainId } from "./nft-mode";

export const LAUNCH_FEE_USD = 10;
export const LAUNCH_FEE_QUOTE_TTL = 60_000;
export const LAUNCH_FEE_MINING_GRACE_SECONDS = 600;
// A sanity ceiling on the platform's ETH quote for the $10 fee: 0.05 ETH is $10 at an ETH price of $200, so any real quote is far below
// it. The wallet refuses a larger quote, so a wrong or tampered price can never ask for more than this.
export const LAUNCH_FEE_MAX_WEI = 5n * 10n ** 16n;
export type LaunchFeeStable = { address: Address; symbol: string; decimals: 6; amount: bigint };
export const LAUNCH_FEE_STABLE: Partial<Record<NftChainId, LaunchFeeStable>> = {
  4663: { address: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"), symbol: "USDG", decimals: 6, amount: 10_000_000n },
};
// No NFT launch-fee payment predates NFT mode; set before launch. An older exact 10 USDG transfer to the treasury is not a launch fee.
// A chain without an entry accepts no stablecoin fee at all.
export const LAUNCH_FEE_MIN_BLOCK: Partial<Record<NftChainId, bigint>> = { 4663: 87_500_000n };
export type LaunchFee = { txHash: Hex; asset: "stable" | "native"; wei?: string; expiresAt?: number; mac?: Hex };
