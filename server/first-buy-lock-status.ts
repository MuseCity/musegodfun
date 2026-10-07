import { bundlerAbi } from "@whetstone-research/doppler-sdk/evm";
import { encodeFunctionData, zeroAddress, type Address } from "viem";
import { sameAddress } from "../src/lib/config";
import type { FirstBuyLockRecord, FirstBuyLockStatus } from "../src/lib/launch-plan";

export function firstBuyLockStatusFromPosition(tokenAddress: Address, chainId: 8453 | 4663, bundler: Address,
  position: readonly [Address, boolean, bigint, bigint, bigint, bigint, bigint], claimable: bigint,
  record?: FirstBuyLockRecord): FirstBuyLockStatus | null {
  if (sameAddress(position[0], zeroAddress) && position[5] === 0n) return null;
  const lockDays = Number(position[4] / 86400n);
  if (sameAddress(position[0], zeroAddress) || position[1] || position[2] <= 0n ||
    position[3] !== position[4] || ![30, 90, 365].includes(lockDays) || position[4] !== BigInt(lockDays) * 86400n ||
    position[2] + position[4] > BigInt(Number.MAX_SAFE_INTEGER) || position[5] <= 0n || position[6] < 0n ||
    position[6] > position[5] || claimable < 0n || claimable > position[5] - position[6])
    throw new Error("The first buy lock is not a supported recipient-controlled position.");
  let recordVerified = false;
  try { recordVerified = !!record && sameAddress(record.bundler, bundler) && sameAddress(position[0], record.recipient) &&
    position[2] === BigInt(record.start) && position[3] === BigInt(record.cliffDuration) &&
    position[4] === BigInt(record.vestingDuration) && position[5] === BigInt(record.totalAmount);
  } catch { /* A malformed optional catalog record cannot block custody recovery. */ }
  return { bundler, recipient: position[0], totalAmount: String(position[5]), start: Number(position[2]),
    cliffDuration: Number(position[3]), vestingDuration: Number(position[4]), lockDays: lockDays as 30 | 90 | 365,
    tokenAddress, deploymentChainId: chainId, recordVerified, claimedAmount: String(position[6]), claimableAmount: String(claimable),
    unlockAt: Number(position[2] + position[4]),
    ...(claimable > 0n ? { claimTransaction: { to: bundler,
      data: encodeFunctionData({ abi: bundlerAbi, functionName: "claim", args: [tokenAddress] }), value: "0" } } : {}) };
}
