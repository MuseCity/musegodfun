import type { ReactNode } from "react";
import { feePolicyFor } from "../lib/fee-policy";

const percent = (bps: number) => `${bps / 100}%`;

export default function FeeBreakdown({ policy, children }: {
  policy: string | undefined;
  children?: ReactNode;
}) {
  const shares = feePolicyFor(policy);
  if (!shares) return <div className="fee-breakdown">
    <p>This pool has no identified fee policy. Only claimable on-chain amounts are shown; no revenue split or buyback budget is estimated.</p>
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
    <p>The treasury wallet allocates funds manually by batch. A budget does not represent a completed buyback or burn.</p>
    <details className="fee-gross">
      <summary>Equivalent share of total fees</summary>
      <p>The percentages below use total fees before Doppler as the 100% basis and express the same two-stage policy.</p>
      <dl>{gross.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{percent(item.share)}</dd></div>)}</dl>
    </details>
    <p>The nominal total fee is 1.05% (1% trading fee + 0.05% LP fee). The on-chain quote determines the actual amount. Each pool follows its policy at launch.</p>
    {children}
  </div>;
}
