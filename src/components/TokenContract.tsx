import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { explorerFor, shortAddress, type Stock, type TokenRecord } from "../lib/config";
import { feeShares } from "../lib/token-detail";

/** The On-chain tab's record of the launch: contract, pair, pool, creator and the fixed fee beneficiaries. `children` adds the fee
 * disclosure and the launch curve. */
export default function TokenContract({ token, stock, children }: { token: TokenRecord; stock: Stock; children?: ReactNode }) {
  const explorer = explorerFor(token), live = token.mode !== "fork" && explorer;
  const shares = feeShares(token);
  const address = (value: string, kind: "token" | "address" | "tx" = "address") => live
    ? <a href={`${explorer}/${kind}/${value}`} target="_blank" rel="noreferrer">{shortAddress(value)}<ArrowUpRight size={14} /></a>
    : <code title={value}>{shortAddress(value)}</code>;
  return (
    <section className="card contract-card" aria-labelledby="contract-title">
      <h2 id="contract-title" className="card-title">Contract and launch record</h2>
      <dl className="rows">
        <div><dt>Token contract</dt><dd>{address(token.address, "token")}</dd></div>
        <div><dt>Quote asset</dt><dd>{live ? <a href={`${explorer}/token/${stock.address}`} target="_blank" rel="noreferrer">{stock.symbol}<ArrowUpRight size={14} /></a> : <code>{stock.symbol}</code>}</dd></div>
        <div><dt>Creator</dt><dd>{token.creator ? address(token.creator) : "Not verified"}</dd></div>
        {shares && token.nft && <div><dt>Creator share recipient</dt><dd className="sans">The NFT's fee vault ({shares.creator}%)</dd></div>}
        {shares && token.feeEngine && <div><dt>Fee engine · {shares.buyback}% buyback</dt><dd>{address(token.feeEngine)}</dd></div>}
        {shares && token.feeTreasury && <div><dt>Operations · {shares.operations}%</dt><dd>{address(token.feeTreasury)}</dd></div>}
        <div><dt>Pool ID</dt><dd><code title={token.poolId}>{shortAddress(token.poolId)}</code></dd></div>
        {token.transactionHash && <div><dt>Launch transaction</dt><dd>{address(token.transactionHash, "tx")}</dd></div>}
        <div><dt>Supply</dt><dd>1,000,000,000</dd></div>
        {token.openingValuationUnverified && <div>
          <dt>Opening valuation</dt>
          <dd className="sans">Unverified · recovered from a backup without a platform attestation</dd>
        </div>}
        <div><dt>Created</dt><dd>{new Date(token.createdAt).toLocaleString("en-US")}</dd></div>
      </dl>
      {children}
    </section>
  );
}
