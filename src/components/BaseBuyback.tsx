import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { formatUnits } from "viem";
import { chainApi } from "../lib/api";
import { explorerFor, shortAddress, type RuntimeConfig } from "../lib/config";
import type { BaseCollectorStatus } from "../lib/base-buyback";
import type { VaultLedgerReport } from "../lib/buyback-vault-ledger";

type Status = BaseCollectorStatus & { vaultLedger: VaultLedgerReport };
const quantity = (raw: string, decimals = 18) => Number(formatUnits(BigInt(raw), decimals)).toLocaleString("en-US", { maximumSignificantDigits: 8 });

export default function BaseBuyback({ config, onRefresh }: { config: RuntimeConfig; onRefresh: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true, reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await chainApi<Status>(8453, "/buyback/engine");
        if (active) { setStatus(next); setError(""); }
      } catch { if (active) setError("Fee processing status could not be refreshed. Previous values may be stale."); }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [revision, config.feeEngine]);
  const ledger = status?.vaultLedger, baseExplorer = explorerFor({ mode: "base" }), rhExplorer = explorerFor({ mode: "robinhood" });
  const rows = status?.assets.filter(asset => BigInt(asset.pending) > 0n || BigInt(asset.untracked) > 0n || BigInt(asset.automationBalance) > 0n) ?? [];
  const nativeState = status?.nativeAutomationState;
  return <section className="engine-activity" aria-labelledby="base-fees-title">
    <div className="section-head"><div><h2 id="base-fees-title" className="card-title">Base fee buybacks</h2>
      <p className="card-sub">Base fees → Splits native Automation / Relay → Robinhood Treasury → shared Vault → MUSEGOD at dead</p></div>
      <button type="button" className="round-button small" aria-label="Refresh Base fee processing" onClick={() => { setRevision(value => value + 1); onRefresh(); }}><RefreshCw size={16} /></button>
    </div>
    {error && <p className="hint" role="status">{error}</p>}
    <dl className="burn-stats">
      <div><dt>WETH received from Base</dt><dd>{status?.available && status.ledgerComplete ? quantity(status.totalBridgedWeth) : "—"}</dd><dd className="sub">canonical WETH received on Robinhood</dd></div>
      <div><dt>Awaiting shared vault execution</dt><dd>{ledger?.attributionReady ? quantity(ledger.basePendingWeth) : "—"}</dd><dd className="sub">verified Base WETH already in the Vault</dd></div>
      <div><dt>Burn attributed by FIFO</dt><dd>{ledger?.attributionReady ? quantity(ledger.baseAttributedMuseToDead) : "—"}</dd><dd className="sub">MUSEGOD actually sent to dead</dd></div>
    </dl>
    <div className={`guard${!status?.available || status.paused || nativeState !== "configured" ? " warn" : ""}`}>
      <b>{!status ? "Reading fee processing…" : !status.available ? "Awaiting Base fee adapter activation" : status.paused ? "Fee forwarding paused" : "Fee forwarding available"}</b>
      <span>{status?.error ?? "The adapter forwards identified fees to native Automation. Small balances, missing routes and unconfirmed transfers can remain pending."}</span>
    </div>
    <dl className="rows">
      <div><dt>Fee adapter · Base</dt><dd>{status?.collector ? <a href={`${baseExplorer}/address/${status.collector}`} target="_blank" rel="noreferrer">{shortAddress(status.collector)}<ArrowUpRight size={14} /></a> : "Deployment pending"}</dd></div>
      <div><dt>Dedicated Automation · Base</dt><dd>{status?.automation ? <a href={`${baseExplorer}/address/${status.automation}`} target="_blank" rel="noreferrer">{shortAddress(status.automation)}<ArrowUpRight size={14} /></a> : "Configuration pending"}</dd></div>
      <div><dt>Native Automation rule</dt><dd>{nativeState === "configured" ? "Configuration verified; execution requires receipts" : nativeState === "paused" ? "Paused" : "Authorization and rule unverified"}</dd></div>
      <div><dt>Treasury · Robinhood</dt><dd>{status ? <a href={`${rhExplorer}/address/${status.destinationTreasury}`} target="_blank" rel="noreferrer">{shortAddress(status.destinationTreasury)}<ArrowUpRight size={14} /></a> : "—"}</dd></div>
      <div><dt>Shared Vault · Robinhood</dt><dd>{status ? <a href={`${rhExplorer}/address/${status.destinationVault}`} target="_blank" rel="noreferrer">{shortAddress(status.destinationVault)}<ArrowUpRight size={14} /></a> : "—"}</dd></div>
      <div><dt>Accounting checkpoint</dt><dd>{ledger?.initialized ? `Block ${ledger.checkpointBlock}; indexed through ${ledger.indexedThrough}` : "Not established"}</dd></div>
    </dl>
    {!ledger?.attributionReady && <p className="hint">{ledger?.reason ?? "FIFO accounting is unavailable until the complete Vault ledger is verified."}</p>}
    {ledger?.attributionReady && !ledger.caughtUp && <p className="hint">Accounting is verified through block {ledger.indexedThrough}. Newer confirmed blocks are awaiting indexing.</p>}
    {rows.length > 0 && <details className="card disclosure"><summary>Pending fees and unclassified balances</summary>
      <dl className="rows">{rows.map(asset => <div key={asset.address}><dt>{asset.symbol}</dt><dd>{quantity(asset.pending, asset.decimals)} adapter fees pending · {quantity(asset.automationBalance, asset.decimals)} Automation balance{BigInt(asset.untracked) > 0n && <> · {quantity(asset.untracked, asset.decimals)} adapter balance unclassified</>}</dd></div>)}</dl>
      <p className="hint">Automation balances may include unrelated transfers. They are not counted as fee income without verified provenance.</p>
    </details>}
    {status?.available && !status.assetsComplete && <p className="hint">Balances cover admitted paired assets, WETH and identified launched tokens. Other assets may not be listed.</p>}
    {status && status.batches.length > 0 && <details className="card disclosure"><summary>Recent processing receipts</summary>
      <dl className="rows">{status.batches.map(batch => <div key={batch.id}><dt>{batch.kind.replaceAll("_", " ")} · {batch.status.replaceAll("_", " ")}</dt><dd>
        {batch.sourceHash && <a href={`${baseExplorer}/tx/${batch.sourceHash}`} target="_blank" rel="noreferrer">Base receipt <ArrowUpRight size={14} /></a>}
        {batch.destinationHash && <a href={`${rhExplorer}/tx/${batch.destinationHash}`} target="_blank" rel="noreferrer">Robinhood receipt <ArrowUpRight size={14} /></a>}
      </dd></div>)}</dl>
    </details>}
    {status?.available && !status.ledgerComplete && <p className="hint">Processing history is incomplete. Verified receipt totals exclude unknown transfers and can change after canonical replay.</p>}
    <p className="hint">The adapter receives only the isolated buyback allocation and does not deduct another 20%. Native Automation can convert paired-asset and launched-token fees when a route is available. Donations and unknown transfers are separate from fee income.</p>
    <p className="hint">Native Automation is controlled by its owner and authorized signer and uses provider quotes and Relay. Its conversions do not carry the former signed Collector’s 99% source minimum or rolling source cap. Pausing fee forwarding does not revoke Automation’s execution authority.</p>
    <p className="hint">Robinhood Treasury receipts are forwarded to the shared Vault before buybacks. Base burns use FIFO accounting and proportional allocation of actual dead-address transfers; caller profit is separate. Sources share funds on chain, and a bridge submission or provider success label alone does not prove arrival or a burn.</p>
  </section>;
}
