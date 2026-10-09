import { useEffect, useState } from "react";
import { ArrowUpRight, Flame } from "lucide-react";
import { formatUnits } from "viem";
import { deploymentChain, explorerFor, networkName, shortAddress, type RuntimeConfig } from "../lib/config";
import { FEE_SHARES, feePolicyFor, launchFeePolicy, MUSEGOD_BUYBACK } from "../lib/fee-policy";
import { chainApi } from "../lib/api";
import type { MarketSummary } from "../lib/market";
import { MUSEGOD } from "../lib/musegod";
import { burnShare, useMusegodBurn } from "../lib/musegod-burn";
import FeeBreakdown from "./FeeBreakdown";
import BuybackEngine from "./BuybackEngine";
import BaseBuyback from "./BaseBuyback";

function ChainAddress({ address, explorer }: { address: string; explorer?: string }) {
  return explorer
    ? <a className="buyback-address" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">{address}<ArrowUpRight size={14} /></a>
    : <code className="wrap">{address}</code>;
}
const whole = (value: number, digits = 2) => value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default function BuybackPage({ config }: { config: RuntimeConfig | null }) {
  const [revision, setRevision] = useState(0);
  const burn = useMusegodBurn(revision);
  const [price, setPrice] = useState<{ usd: number; stale: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    chainApi<MarketSummary>(4663, "/musegod/market/summary")
      .then((summary) => { if (active) setPrice(summary.status === "unavailable" || summary.priceUsd == null ? null : { usd: summary.priceUsd, stale: summary.status === "stale" }); })
      .catch(() => { if (active) setPrice(null); });
    return () => { active = false; };
  }, [revision]);
  const shares = feePolicyFor(launchFeePolicy(config)) ?? FEE_SHARES;
  const robinhoodExplorer = explorerFor({ mode: "robinhood" });
  const data = burn.data;
  const burned = data ? Number(formatUnits(data.burned, 18)) : null;
  const supply = data ? Number(formatUnits(data.supply, 18)) : null;
  const share = data ? burnShare(data) : null;
  const [integer, fraction] = burned === null ? ["—", ""] : whole(burned).split(".");
  return <>
    <section className="burn-hero" aria-labelledby="burn-title">
      <div className="burn-hero-head">
        <span className="burn-logo" aria-hidden="true"><img src={MUSEGOD.image} alt="" /></span>
        <div>
          <h1 id="burn-title">MUSEGOD buyback and burn</h1>
          <p>{(shares.buyback / 100).toLocaleString("en-US")}% of every new launch’s trading fee is allocated to the MUSEGOD buyback budget. Fees await collection, conversion and execution; purchased MUSEGOD goes to the dead address.</p>
        </div>
      </div>
      <div className="burn-total">
        <span className="burn-eyebrow"><Flame size={14} aria-hidden="true" /> MUSEGOD BURNED · ALL TIME</span>
        <p className="burn-number" aria-live="polite">
          <span className="int">{integer}</span>{fraction && <span className="frac">.{fraction}</span>}
          <span className="unit">MUSEGOD</span>
        </p>
        <p className="burn-caption">
          {data ? <>Total burned = MUSEGOD held by <a href={`${robinhoodExplorer}/address/${MUSEGOD_BUYBACK.burnAddress}`} target="_blank" rel="noreferrer" className="mono">{shortAddress(MUSEGOD_BUYBACK.burnAddress)}</a>, read on-chain at block <span className="mono">{data.blockNumber.toLocaleString("en-US")}</span></>
            : burn.error ? <>The dead-address balance could not be read. <button type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button></> : "Reading the dead-address balance on Robinhood Chain…"}
        </p>
      </div>
      <dl className="burn-stats">
        <div><dt>Share of supply</dt><dd>{share === null ? "—" : `${share.toFixed(2)}%`}</dd><dd className="sub">of <span className="mono">{supply === null ? "—" : supply.toLocaleString("en-US")}</span></dd></div>
        <div><dt>Value burned</dt><dd>{burned !== null && price !== null ? `≈ $${(burned * price.usd).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })}` : "—"}</dd>
          <dd className="sub">{price !== null ? <>at <span className="mono">${price.usd.toLocaleString("en-US", { maximumSignificantDigits: 3 })}</span> per MUSEGOD{price.stale ? " · previous snapshot" : ""}</> : "MUSEGOD price unavailable"}</dd></div>
        <div><dt>Circulating supply</dt><dd>{burned !== null && supply !== null ? whole(supply - burned) : "—"}</dd><dd className="sub">total supply − burned</dd></div>
      </dl>
      <p className="burn-footnote">Transfers to the dead address remove tokens from circulation; they do not reduce ERC-20 totalSupply. Value uses the current Bankr / Pools price, not the price at each burn.</p>
    </section>
    {!config ? <p role="status">Reading the selected network configuration…</p>
      : deploymentChain(config) === 8453 ? <BaseBuyback config={config} onRefresh={() => setRevision((value) => value + 1)} />
      : <BuybackEngine config={config} onRefresh={() => setRevision((value) => value + 1)} />}
    <details className="card disclosure">
      <summary>How new pool fees are distributed</summary>
      <FeeBreakdown policy={launchFeePolicy(config)} />
      <dl className="rows">
        <div><dt>Buyback asset · Robinhood Chain (4663)</dt><dd><ChainAddress address={MUSEGOD_BUYBACK.tokenAddress} explorer={robinhoodExplorer} /></dd></div>
        <div><dt>Burn recipient</dt><dd><ChainAddress address={MUSEGOD_BUYBACK.burnAddress} explorer={robinhoodExplorer} /></dd></div>
        <div><dt>{config ? networkName(config) : "Platform"} treasury</dt><dd>{config?.treasury ? <ChainAddress address={config.treasury} explorer={explorerFor(config)} /> : "Not configured yet"}</dd></div>
      </dl>
      <p className="hint">A reserved budget is not evidence of a completed purchase or burn.</p>
    </details>
  </>;
}
