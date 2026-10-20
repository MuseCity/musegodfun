import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { explorerFor, shortAddress, type TokenRecord } from "../lib/config";
import { feeShares } from "../lib/token-detail";

/** The About tab's on-chain record: only facts the rest of the page does not show (tasks/token-ip-detail-plan.md §12). The contract
 * address, pair, creator, supply and launch date stay in the hero, the creator share in the beneficiary card. `children` adds the fee
 * disclosure and the launch curve. */
export default function TokenContract({ token, children }: { token: TokenRecord; children?: ReactNode }) {
  const explorer = explorerFor(token), live = token.mode !== "fork" && explorer;
  const shares = feeShares(token);
  const address = (value: string, kind: "address" | "tx" = "address") => live
    ? <a href={`${explorer}/${kind}/${value}`} target="_blank" rel="noreferrer">{shortAddress(value)}<ArrowUpRight size={14} /></a>
    : <code title={value}>{shortAddress(value)}</code>;
  return (
    <section className="card contract-card" aria-labelledby="contract-title">
      <h2 id="contract-title" className="card-title">On-chain record</h2>
      <dl className="rows">
        {shares && token.feeEngine && <div><dt>Fee engine · {shares.buyback}% buyback</dt><dd>{address(token.feeEngine)}</dd></div>}
        {shares && token.feeTreasury && <div><dt>Operations · {shares.operations}%</dt><dd>{address(token.feeTreasury)}</dd></div>}
        <div><dt>Pool ID</dt><dd><code title={token.poolId}>{shortAddress(token.poolId)}</code></dd></div>
        {token.transactionHash && <div><dt>Launch transaction</dt><dd>{address(token.transactionHash, "tx")}</dd></div>}
      </dl>
      {children}
    </section>
  );
}
