import type { ReactNode } from "react";
import { ENGINE_FEE_POLICY, BASE_AUTOMATION_FEE_POLICY, BASE_COLLECTOR_FEE_POLICY, feePolicyFor } from "../lib/fee-policy";
import { LP_FEE_PPM, TRADING_FEE_BPS } from "../lib/trading-fee";

const percent = (bps: number) => `${bps / 100}%`;

export default function FeeBreakdown({ policy, tradingFeeBps, children }: {
  policy: string | undefined;
  tradingFeeBps?: number;
  children?: ReactNode;
}) {
  const shares = feePolicyFor(policy);
  const feeRate = tradingFeeBps !== undefined && (TRADING_FEE_BPS as readonly number[]).includes(tradingFeeBps)
    ? <p>The nominal total fee is {percent(tradingFeeBps + LP_FEE_PPM / 100)} ({percent(tradingFeeBps)} trading fee + 0.05% LP fee). The on-chain quote determines the actual amount. Each pool follows its policy at launch.</p>
    : <p>The trading fee has not been verified here. The on-chain quote determines the actual amount. Each pool follows its policy at launch.</p>;
  if (!shares) return <div className="fee-breakdown">
    <p>This pool has no identified fee policy. Claimable on-chain amounts are shown without estimating a revenue split or buyback budget.</p>
    {feeRate}
    {children}
  </div>;
  const gross = [
    { label: "Creator", share: shares.creator },
    { label: "MUSEGOD buyback budget", share: shares.buyback },
    { label: "Platform operating budget", share: shares.operations },
    { label: "Doppler", share: shares.protocol },
  ].filter((item) => item.share > 0);
  return <div className="fee-breakdown">
    {shares.operations === 0 && <p className="fee-policy-version">This pool retains its original fee policy.</p>}
    <p className="fee-protocol">Protocol fees are deducted first: Doppler receives <strong>{percent(shares.protocol)}</strong> of total fees.</p>
    <section className="fee-stage" aria-label="Net fee distribution">
      <h4>Net fee distribution</h4>
      <p>The fees remaining after Doppler are the 100% basis</p>
      <div className="fee-track" aria-hidden="true">
        <i className="creator" style={{ flex: shares.creatorNet }} />
        <i className="platform" style={{ flex: shares.platformNet }} />
      </div>
      <dl className="fee-legend">
        <div><dt>Creator</dt><dd>{percent(shares.creatorNet)}</dd></div>
        <div><dt>Platform</dt><dd>{percent(shares.platformNet)}</dd></div>
      </dl>
    </section>
    <section className="fee-stage" aria-label="Platform income allocation">
      <h4>Platform income allocation</h4>
      <p>Only the platform’s income is the 100% basis</p>
      <div className="fee-track" aria-hidden="true">
        <i className="buyback" style={{ flex: shares.platformBuyback }} />
        {shares.platformOperations > 0 && <i className="operations" style={{ flex: shares.platformOperations }} />}
      </div>
      <dl className="fee-legend">
        <div><dt>MUSEGOD buyback budget</dt><dd>{percent(shares.platformBuyback)}</dd></div>
        {shares.platformOperations > 0 && <div><dt>Operating budget</dt><dd>{percent(shares.platformOperations)}</dd></div>}
      </dl>
    </section>
    <p>{policy === BASE_AUTOMATION_FEE_POLICY ? "The isolated buyback share goes to the Base fee adapter, then to a dedicated Splits Automation account. Native Automation converts paired-asset and launched-token fees and uses Relay to send canonical WETH to the Robinhood treasury, which forwards verified receipts to the shared buyback vault. Small balances or unavailable routes remain pending. Automation is controlled by its account owner and authorized signer; collection or bridging does not prove a completed buyback." : policy === BASE_COLLECTOR_FEE_POLICY ? "The buyback share goes directly to the Base Collector; the operating share goes to the treasury. Supported B20 fees are converted to WETH and bridged to the shared Robinhood vault for guarded MUSEGOD buybacks. Meme-side fees can remain pending. Bridging is not a completed burn." : policy === ENGINE_FEE_POLICY ? "The buyback share goes directly to the public fee engine; the operating share goes to the treasury. Anyone can process supported fees through WETH and execute a MUSEGOD buyback. Buyback fees without a configured price source go to an operator-controlled Splits Automation account for external processing. Collected or forwarded fees are not completed burns." : "The treasury wallet allocates funds manually by batch. A budget does not represent a completed buyback or burn."}</p>
    <details className="fee-gross">
      <summary>Equivalent share of total fees</summary>
      <p>The percentages below use total fees before Doppler as the 100% basis and express the same two-stage policy.</p>
      <dl>{gross.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{percent(item.share)}</dd></div>)}</dl>
    </details>
    {feeRate}
    {children}
  </div>;
}

// Gross policy shares applied to a verified trading fee: where each trade's
// fee goes, before the separate 0.05% LP fee. Unknown inputs render nothing.
export function FeeSplitBar({ policy, tradingFeeBps }: { policy: string | undefined; tradingFeeBps?: number }) {
  const shares = feePolicyFor(policy);
  if (!shares || tradingFeeBps === undefined || !(TRADING_FEE_BPS as readonly number[]).includes(tradingFeeBps)) return null;
  const of = (share: number) => `${Number((tradingFeeBps * share / 1_000_000).toFixed(4))}%`;
  const parts = [
    { key: "creator", label: "Creator", share: shares.creator },
    { key: "buyback", label: "MUSEGOD buyback budget", share: shares.buyback },
    { key: "operations", label: "Operations", share: shares.operations },
    { key: "protocol", label: "Doppler", share: shares.protocol },
  ].filter((part) => part.share > 0);
  return <div className="fee-split">
    <div className="fee-split-head">
      <span>Where each <span className="mono">{percent(tradingFeeBps)}</span> trading fee goes</span>
      <span>plus a <span className="mono">{percent(LP_FEE_PPM / 100)}</span> LP fee</span>
    </div>
    <div className="fee-split-bar" aria-hidden="true">
      {parts.map((part) => <i key={part.key} className={part.key} style={{ flex: part.share }} />)}
    </div>
    <dl className="fee-split-legend">
      {parts.map((part) => <div key={part.key}><dt><i className={part.key} aria-hidden="true" />{part.label}</dt><dd>{of(part.share)}</dd></div>)}
    </dl>
  </div>;
}
