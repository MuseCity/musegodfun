import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { explorerFor, shortAddress, type Stock, type TokenRecord } from "../lib/config";

export default function TokenAbout({ token, stock, children }: { token: TokenRecord; stock: Stock; children: ReactNode }) {
  const explorer = explorerFor(token);
  return (
    <section className="card about-card" aria-labelledby="about-title">
      <h2 id="about-title" className="card-title">About {token.name}</h2>
      <p className="body-copy">
        {token.description || "The creator has not added a description yet."}
      </p>
      <details className="disclosure boxed">
        <summary>Contract details</summary>
        <dl className="rows">
          <div>
            <dt>Token contract</dt>
            <dd>
              {token.mode === "fork" ? (
                <code>{shortAddress(token.address)}</code>
              ) : (
                <a href={`${explorer}/token/${token.address}`} target="_blank" rel="noreferrer">
                  {shortAddress(token.address)}<ArrowUpRight size={14} />
                </a>
              )}
            </dd>
          </div>
          <div>
            <dt>Quote asset</dt>
            <dd>
              {explorer ? <a href={`${explorer}/token/${stock.address}`} target="_blank" rel="noreferrer">
                {stock.symbol}<ArrowUpRight size={14} />
              </a> : <code>{stock.symbol}</code>}
            </dd>
          </div>
          <div>
            <dt>Creator</dt>
            <dd>
              {token.creator ? shortAddress(token.creator) : "Not verified"}
            </dd>
          </div>
          <div>
            <dt>Pool ID</dt>
            <dd><code title={token.poolId}>{shortAddress(token.poolId)}</code></dd>
          </div>
          <div>
            <dt>Supply</dt>
            <dd>1,000,000,000</dd>
          </div>
          {token.openingValuationUnverified && <div>
            <dt>Opening valuation</dt>
            <dd className="sans">Unverified · recovered from a backup without a platform attestation</dd>
          </div>}
          <div>
            <dt>Created</dt>
            <dd>{new Date(token.createdAt).toLocaleString("en-US")}</dd>
          </div>
        </dl>
      </details>
      {children}
    </section>
  );
}
