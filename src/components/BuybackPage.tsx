import { ArrowUpRight, Flame } from "lucide-react";
import { explorerFor, networkName, type RuntimeConfig } from "../lib/config";
import { launchFeePolicy, MUSEGOD_BUYBACK } from "../lib/fee-policy";
import FeeBreakdown from "./FeeBreakdown";
import BuybackEngine from "./BuybackEngine";

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
        <h1>MUSEGOD buyback and burn<span className="accent">.</span></h1>
        <p>Follow fee collection, WETH conversion and confirmed MUSEGOD burns.</p>
      </div>
      <Flame size={32} />
    </div>
    <div className="buyback-grid">
      <section className="panel">
        <h2>How new pool fees are distributed</h2>
        <FeeBreakdown policy={launchFeePolicy(config)} />
        <dl className="buyback-facts">
          <div><dt>Buyback asset · Robinhood Chain (4663)</dt><dd><ChainAddress address={MUSEGOD_BUYBACK.tokenAddress} explorer={explorerFor({ mode: "robinhood" })} /></dd></div>
          <div><dt>Burn recipient</dt><dd><ChainAddress address={MUSEGOD_BUYBACK.burnAddress} explorer={explorerFor({ mode: "robinhood" })} /></dd></div>
          <div><dt>{config ? networkName(config) : "Platform"} treasury</dt><dd>{config?.treasury ? <ChainAddress address={config.treasury} explorer={explorerFor(config)} /> : "Not configured yet"}</dd></div>
        </dl>
        <p className="muted">Transfers to the dead address remove tokens from circulation; they do not reduce ERC-20 totalSupply. A reserved budget is not evidence of a completed purchase or burn.</p>
      </section>
      <BuybackEngine config={config} />
    </div>
  </>;
}
