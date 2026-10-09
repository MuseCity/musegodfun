import { useEffect, useState } from "react";
import { erc20Abi, formatUnits } from "viem";
import { MUSEGOD_BUYBACK } from "./fee-policy";
import { publicClient } from "./wallet";

export type MusegodBurn = { burned: bigint; supply: bigint; blockNumber: bigint };

// Total burned = MUSEGOD held by the dead address, read on Robinhood Chain.
// Transfers there leave ERC-20 totalSupply unchanged.
export function useMusegodBurn(revision = 0) {
  const [state, setState] = useState<{ data: MusegodBurn | null; error: string }>({ data: null, error: "" });
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const blockNumber = await publicClient.getBlockNumber();
        const [burned, supply] = await Promise.all([
          publicClient.readContract({ address: MUSEGOD_BUYBACK.tokenAddress, abi: erc20Abi, functionName: "balanceOf",
            args: [MUSEGOD_BUYBACK.burnAddress], blockNumber }),
          publicClient.readContract({ address: MUSEGOD_BUYBACK.tokenAddress, abi: erc20Abi, functionName: "totalSupply", blockNumber }),
        ]);
        if (active) setState({ data: { burned, supply, blockNumber }, error: "" });
      } catch (failure) {
        if (active) setState((previous) => ({ data: previous.data, error: failure instanceof Error ? failure.message : String(failure) }));
      }
    })();
    return () => { active = false; };
  }, [revision]);
  return state;
}
export function burnShare(data: MusegodBurn) {
  return data.supply > 0n ? Number(data.burned * 1_000_000n / data.supply) / 10_000 : null;
}
export function compactAmount(raw: bigint, decimals = 18) {
  return Number(formatUnits(raw, decimals)).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}
