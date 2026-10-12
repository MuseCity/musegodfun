import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { formatUnits } from "viem";
import { chainApi } from "../lib/api";
import { explorerFor, shortAddress, type RuntimeConfig } from "../lib/config";
import type { BaseCollectorStatus, RobinhoodBuybackSummary } from "../lib/base-buyback";

const quantity = (raw: string | null | undefined, decimals = 18) => raw == null ? "—" : Number(formatUnits(BigInt(raw),decimals)).toLocaleString("en-US",{maximumSignificantDigits:8});
export default function BaseBuyback({config,onRefresh,summary}:{config:RuntimeConfig;onRefresh:()=>void;summary:RobinhoodBuybackSummary|null}) {
  const [status,setStatus] = useState<BaseCollectorStatus|null>(null),[error,setError] = useState(""),[revision,setRevision] = useState(0);
  useEffect(()=>{
    let active=true,reading=false;
    const read=async()=>{ if(reading)return;reading=true;
      try {const next=await chainApi<BaseCollectorStatus>(8453,"/buyback/engine");if(active){setStatus(next);setError("");}}
      catch {if(active)setError("Base fee totals are delayed. Previous values may be stale.");}
      finally {reading=false;}
    };
    void read();const timer=setInterval(()=>void read(),300_000);
    return()=>{active=false;clearInterval(timer);};
  },[revision,config.feeEngine]);
  const baseExplorer=explorerFor({mode:"base"}),rhExplorer=explorerFor({mode:"robinhood"});
  const collector=status?.collector??config.feeEngine,automation=status?.automation??config.automationReceiver;
  const delayed=!!error||!!status&&(!status.available||!!status.stale);
  const rows=status?.assets.filter(asset=>[asset.totalClaimed,asset.totalReleased,asset.totalUntrackedReleased??"0",asset.automationBalance].some(raw=>BigInt(raw)>0n))??[];
  return <section className="engine-activity" aria-labelledby="base-fees-title">
    <div className="section-head"><div><h2 id="base-fees-title" className="card-title">Base fee buybacks</h2>
      <p className="card-sub">Base Collector → Splits Automation / Relay → Robinhood Treasury → shared Vault → MUSEGOD at dead</p></div>
      <button type="button" className="round-button small" aria-label="Refresh Base fee totals" onClick={()=>{setRevision(value=>value+1);onRefresh();}}><RefreshCw size={16}/></button>
    </div>
    {error&&<p className="hint" role="status">{error}</p>}
    <dl className="burn-stats">
      <div><dt>Shared Robinhood Treasury</dt><dd>{quantity(summary?.treasuryWeth)} WETH</dd><dd className="sub">current balance from all sources</dd></div>
      <div><dt>Shared Vault spent</dt><dd>{quantity(summary?.vaultSpentWeth)} WETH</dd><dd className="sub">cumulative across all sources</dd></div>
      <div><dt>Shared Vault sent to dead</dt><dd>{quantity(summary?.vaultMuseToDead)}</dd><dd className="sub">MUSEGOD across all sources</dd></div>
    </dl>
    <div className={`guard${delayed||status?.paused?" warn":""}`}><b>{delayed?"Base fee totals delayed":!status?"Reading Base fee totals…":status.paused?"Collector forwarding paused":"Base fee totals"}</b>
      <span>{status?.error??"Fees are processed in batches. Small balances or missing routes can remain pending."}</span></div>
    <dl className="rows">
      <div><dt>Collector · Base</dt><dd>{collector?<a href={`${baseExplorer}/address/${collector}`} target="_blank" rel="noreferrer">{shortAddress(collector)}<ArrowUpRight size={14}/></a>:"Not configured"}</dd></div>
      <div><dt>Automation · Base</dt><dd>{automation?<a href={`${baseExplorer}/address/${automation}`} target="_blank" rel="noreferrer">{shortAddress(automation)}<ArrowUpRight size={14}/></a>:"Not configured"}</dd></div>
      <div><dt>Treasury · Robinhood</dt><dd>{status?<a href={`${rhExplorer}/address/${status.destinationTreasury}`} target="_blank" rel="noreferrer">{shortAddress(status.destinationTreasury)}<ArrowUpRight size={14}/></a>:"—"}</dd></div>
      <div><dt>Shared Vault · Robinhood</dt><dd>{status?<a href={`${rhExplorer}/address/${status.destinationVault}`} target="_blank" rel="noreferrer">{shortAddress(status.destinationVault)}<ArrowUpRight size={14}/></a>:"—"}</dd></div>
      <div><dt>Base sample</dt><dd>{status?.blockNumber?`Block ${status.blockNumber} · ${new Date(status.checkedAt).toLocaleTimeString()}`:"Unavailable"}</dd></div>
    </dl>
    <details className="card disclosure" open={rows.length>0}><summary>Base cumulative fee totals by asset</summary>
      {rows.length?<dl className="rows">{rows.map(asset=><div key={asset.address}><dt>{asset.symbol}</dt><dd>{quantity(asset.totalClaimed,asset.decimals)} claimed · {quantity(asset.totalReleased,asset.decimals)} transferred to Automation · {quantity(asset.totalUntrackedReleased,asset.decimals)} unclassified recovered · {quantity(asset.automationBalance,asset.decimals)} current Automation balance</dd></div>)}</dl>:<p className="hint">{status?.available&&status.assetsComplete?"No nonzero counters or Automation balances in this sample.":"Counters are unavailable."}</p>}
      <p className="hint">Claimed and transferred fees come from Collector counters. Unclassified recovery is separate from fees; Automation balances can include donations.</p>
    </details>
    {status?.available&&!status.assetsComplete&&<p className="hint">Some asset counters or balances are unavailable. Other assets remain visible.</p>}
    <p className="hint">Totals are cached for at least five minutes. Robinhood Treasury, shared Vault and dead-address totals include all sources; they are not a Base-only burn figure.</p>
    <p className="hint">The Collector forwards to its fixed Automation receiver without a second 20% deduction. Splits Automation uses provider quotes and Relay; fees are not converted immediately after every trade. A transfer to Automation is not a completed cross-chain buyback.</p>
  </section>;
}
