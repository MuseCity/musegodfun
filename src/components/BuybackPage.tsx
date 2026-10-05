import { ArrowUpRight, Flame } from "lucide-react";
import { explorerFor, networkName, type RuntimeConfig } from "../lib/config";
import { FEE_POLICY, MUSEGOD_BUYBACK } from "../lib/fee-policy";
import FeeBreakdown from "./FeeBreakdown";

function ChainAddress({ address, explorer }: { address: string; explorer?: string }) {
  return explorer
    ? <a className="buyback-address" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">{address}<ArrowUpRight size={14} /></a>
    : <code className="wrap">{address}</code>;
}

export default function BuybackPage({ config }: { config: RuntimeConfig | null }) {
  return <>
    <div className="page-heading">
      <div>
        <span className="eyebrow">TRADING FEES → MUSEGOD</span>
        <h1>MUSEGOD buyback policy<span className="accent">.</span></h1>
        <p>Platform income reserves a budget for MUSEGOD buybacks under each pool’s fee policy.</p>
      </div>
      <Flame size={32} />
    </div>
    <div className="buyback-grid">
      <section className="panel">
        <h2>How new pool fees are distributed</h2>
        <FeeBreakdown policy={FEE_POLICY} />
        <dl className="buyback-facts">
          <div><dt>Planned buyback asset · Robinhood Chain (4663)</dt><dd><ChainAddress address={MUSEGOD_BUYBACK.tokenAddress} explorer={explorerFor({ mode: "robinhood" })} /></dd></div>
          <div><dt>Planned burn recipient</dt><dd><ChainAddress address={MUSEGOD_BUYBACK.burnAddress} explorer={explorerFor({ mode: "robinhood" })} /></dd></div>
          <div><dt>{config ? networkName(config) : "Platform"} treasury</dt><dd>{config?.treasury ? <ChainAddress address={config.treasury} explorer={explorerFor(config)} /> : "Not configured yet"}</dd></div>
        </dl>
        <p className="muted">Transfers to the dead address remove tokens from circulation; they do not reduce ERC-20 totalSupply. A reserved budget is not evidence of a completed purchase or burn.</p>
      </section>
      <section className="panel" aria-labelledby="buyback-status-heading">
        <h2 id="buyback-status-heading">Execution status</h2>
        <span className="pill">Deferred</span>
        <p className="body-copy">Robinhood Chain token launches, trading, and fee claims are the current priority. Base fee bridging will follow once that workflow is verified.</p>
        <p className="muted">Buyback and burn execution remain a later phase. This page explains the allocation policy and intended target; funds remain with the treasury until an execution flow is ready.</p>
      </section>
    </div>
  </>;
}
