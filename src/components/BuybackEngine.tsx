import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CircleAlert, Info, RefreshCw, TriangleAlert } from "lucide-react";
import { formatUnits, type Hex } from "viem";
import { chainApi } from "../lib/api";
import { BUYBACK_WETH, BUYBACK_WINDOW_CAP, buybackAmountCandidates, buybackVaultAbi, type BuybackEngineStatus, type EngineAction, type EngineConversionQuote } from "../lib/buyback-engine";
import { explorerFor, sameAddress, shortAddress, type RuntimeConfig } from "../lib/config";
import { ENGINE_FEE_POLICY, FEE_POLICIES, MUSEGOD_BUYBACK } from "../lib/fee-policy";

const ENGINE_SHARES = FEE_POLICIES[ENGINE_FEE_POLICY];
import { errorMessage } from "../lib/validation";
import { publicClient, useWallet } from "../lib/wallet";

type Preview = { action: EngineAction; expiresAt: number; label: string; minimum: string; profit?: string };
const quantity = (amount: string | null, decimals = 18) => amount === null ? "Unavailable" : formatUnits(BigInt(amount), decimals);

export default function BuybackEngine({ config, onRefresh }: { config: RuntimeConfig | null; onRefresh?: () => void }) {
  const wallet = useWallet();
  const [status, setStatus] = useState<BuybackEngineStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);
  const [clock, setClock] = useState(Date.now());
  const generation = useRef(0);
  useEffect(() => {
    if (!preview && !status?.feedProposals?.length) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview?.expiresAt, status?.feedProposals]);
  useEffect(() => {
    generation.current++;
    setPreview(null); setError(""); setMessage(""); setHash(null); setBusy(false);
    return () => { generation.current++; };
  }, [wallet.revision, config?.chainId, config?.feeEngine, config?.buybackExecutor, config?.buybackVault, config?.assetFeedOracle, config?.treasury, config?.automationReceiver, config?.automationTreasury, config?.wethForwarder]);
  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    const load = async () => {
      try { const next = await chainApi<BuybackEngineStatus>(4663, "/buyback/engine"); if (!cancelled) setStatus(next); }
      catch (failure) { if (!cancelled) setError(errorMessage(failure)); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [config?.chainId, config?.feeEngine, config?.buybackVault, config?.assetFeedOracle, config?.treasury, config?.automationReceiver, config?.automationTreasury, config?.wethForwarder, refresh]);
  const enabled = !!config?.writesEnabled && !!config.feeEngine && !!status?.available &&
    !!status.vault && !!config.buybackVault && sameAddress(status.vault, config.buybackVault) && !!status.engine && sameAddress(status.engine, config.feeEngine) && status.executor === config.buybackExecutor &&
    !!status.operationsTreasury && !!config.treasury && sameAddress(status.operationsTreasury, config.treasury) &&
    !!status.automationReceiver && !!config.automationReceiver && sameAddress(status.automationReceiver, config.automationReceiver) &&
    !!status.automationTreasury && !!config.automationTreasury && sameAddress(status.automationTreasury, config.automationTreasury) &&
    !!status.wethForwarder && !!config.wethForwarder && sameAddress(status.wethForwarder, config.wethForwarder) &&
    status.sourceDeployed && !!status.assetOracle && !!config.assetFeedOracle && sameAddress(status.assetOracle, config.assetFeedOracle) &&
    !!wallet.account && wallet.chainId === config.chainId;
  async function run(action: EngineAction) {
    if (!config || !enabled || busy) return;
    const current = generation.current;
    setBusy(true); setError(""); setMessage(""); setPreview(null);
    try {
      await wallet.engineAction(action, config, (submitted) => {
        if (current === generation.current) { setHash(submitted); setMessage("Transaction submitted. Waiting for confirmation…"); }
      });
      if (current === generation.current) {
        setMessage("Transaction confirmed. Refreshing on-chain balances…"); setRefresh((value) => value + 1);
        if (action.kind === "burn" || action.kind === "execute") onRefresh?.();
      }
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function previewConversion(token: string, amount: string, symbol: string) {
    if (!enabled || !wallet.account || busy) return;
    const current = generation.current;
    setBusy(true); setError(""); setPreview(null);
    try {
      const result = await chainApi<EngineConversionQuote>(4663, "/buyback/engine/quote", { token, amount, caller: wallet.account });
      if (current !== generation.current) return;
      if (result.action.kind !== "convert" || !sameAddress(result.action.token, token) || result.action.amount !== amount || result.expiresAt !== result.action.deadline * 1000)
        throw new Error("The conversion preview does not match the selected fees. Try again.");
      setPreview({ action: result.action, expiresAt: result.expiresAt, label: `Convert ${symbol} fees to WETH`, minimum: `${quantity(result.action.minWethOut)} WETH minimum` });
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function previewBuyback() {
    if (!enabled || !wallet.account || !config?.buybackVault || !status?.vaultAvailable || status.vaultAvailable === "0" || busy) return;
    const current = generation.current;
    setBusy(true); setError(""); setPreview(null);
    try {
      let selected: Preview | null = null;
      for (const amount of buybackAmountCandidates(BigInt(status.vaultAvailable))) {
        if (current !== generation.current) return;
        const deadline = Math.floor(Date.now() / 1000) + 59;
        try {
          const simulated = await publicClient.simulateContract({ address: config.buybackVault, abi: buybackVaultAbi, functionName: "execute", args: [amount, 1n, BigInt(deadline)], account: wallet.account });
          if (current !== generation.current) return;
          const result = simulated.result as readonly [bigint, bigint];
          if (result[1] <= 0n) continue;
          // A partial fill keeps the Swapper's price and the simulated caller
          // surplus. The selected WETH amount is shown before wallet signing.
          selected = { action: { kind: "execute", amount: String(amount), minProfit: String(result[1]), deadline }, expiresAt: deadline * 1000, label: `Buy MUSEGOD with ${quantity(String(amount))} WETH`, minimum: `${quantity(String(result[0]))} MUSEGOD to the dead address`, profit: `${quantity(String(result[1]))} MUSEGOD caller surplus before gas` };
          break;
        } catch { /* Try the next smaller size without reducing the fixed delivery price. */ }
      }
      if (!selected) throw new Error("None of the tested trade sizes can settle with a positive caller surplus.");
      setPreview(selected);
    } catch (failure) { if (current === generation.current) setError(`A profitable buyback could not be simulated. WETH remains in the budget vault; processing will retry when prices and the budget allow. ${errorMessage(failure)}`); }
    finally { if (current === generation.current) setBusy(false); }
  }
  const explorer = config ? explorerFor(config) : undefined;
  const link = (value: string | null | undefined) => !value ? "Not configured" : explorer
    ? <a href={`${explorer}/address/${value}`} target="_blank" rel="noreferrer" className="mono">{shortAddress(value)}<ArrowUpRight size={12} /></a>
    : <code>{shortAddress(value)}</code>;
  const amount = (value: string | null | undefined, decimals = 18) => value == null ? "—"
    : Number(formatUnits(BigInt(value), decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 });
  const refreshAll = () => { setRefresh((value) => value + 1); onRefresh?.(); };
  const tracked = status?.assets.filter((asset) => asset.pending !== "0" || asset.claimed !== "0" || (asset.synced ?? "0") !== "0" || (asset.untracked ?? "0") !== "0") ?? [];
  const pending = status?.assets.filter((asset) => asset.pending !== "0") ?? [];
  const actionFor = (asset: NonNullable<typeof status>["assets"][number]) => {
    const weth = sameAddress(asset.address, BUYBACK_WETH), muse = sameAddress(asset.address, MUSEGOD_BUYBACK.tokenAddress);
    const unpriced = asset.pricing === "unsupported_static" && !weth && !muse;
    return { weth, muse, unpriced,
      disabled: !enabled || busy || asset.pricing === "unknown" || !!asset.error || (!muse && !unpriced && (asset.available === "0" || !asset.referenceWeth)),
      run: () => muse ? void run({ kind: "burn", amount: asset.pending }) : unpriced ? void run({ kind: "release_unpriced", token: asset.address, amount: asset.pending }) : weth ? void run({ kind: "forward", amount: asset.available }) : void previewConversion(asset.address, asset.available, asset.symbol),
      label: muse ? "Transfer fees to dead address" : unpriced ? "Forward unpriced fees to Automation" : weth ? "Forward available WETH" : "Preview WETH conversion" };
  };
  return <>
    <section className="engine-activity" aria-labelledby="buyback-engine-title">
      <div className="activity-head">
        <h2 id="buyback-engine-title" className="card-title">Public buyback engine</h2>
        <div className="activity-status">
          {status?.engine && <span className={`index-status${status.burnIndexCaughtUp ? " live" : ""}`}><span aria-hidden="true" />{status.burnIndexCaughtUp ? "Index caught up" : "Index catching up"}</span>}
          {status?.blockNumber && <span>Read at block <span className="mono">{Number(status.blockNumber).toLocaleString("en-US")}</span></span>}
          <button type="button" className="round-button small" aria-label="Refresh buyback engine balances" disabled={busy} onClick={refreshAll}><RefreshCw size={16} /></button>
        </div>
      </div>
      {!status ? error ? null : <p role="status" className="loading"><RefreshCw size={16} className="spin" />Reading on-chain engine balances…</p> : !status.engine ? <p className="notice"><Info size={17} aria-hidden="true" /><span>{status.reason}</span></p> : <>
        {status.reason && <p className="notice warning" role="status"><TriangleAlert size={17} aria-hidden="true" /><span>{status.reason}</span></p>}
        <dl className="engine-stats">
          <div className="card halo"><dt>MUSEGOD bought and burned</dt><dd>{amount(status.vaultBurned ?? null)}</dd><dd className="sub">through budget-vault buybacks</dd></div>
          <div className="card"><dt>Direct engine burns</dt><dd>{amount(status.directBurned)}</dd><dd className="sub">MUSEGOD fees sent to the dead address</dd></div>
          <div className="card"><dt>WETH from fee conversions</dt><dd>{amount(status.convertedWeth)}</dd><dd className="sub">paired-asset fees converted by the engine</dd></div>
        </dl>
      </>}
      {message && <p className="notice" role="status"><Info size={17} aria-hidden="true" /><span>{message}</span></p>}
      {error && <p className="notice error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span></p>}
      {hash && (explorer ? <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={14} /></a> : <code className="wrap">{hash}</code>)}
    </section>
    {status?.engine && <div className="engine-columns">
      <section className="card" aria-labelledby="fee-split-title">
        <h2 id="fee-split-title" className="card-title">How each new-launch fee splits</h2>
        <p className="hint">Policy shares of every trading fee on new pools. These are allocations, not measured flows.</p>
        <div className="fee-split">
          <div className="fee-split-bar" aria-hidden="true">
            <i className="creator" style={{ flex: ENGINE_SHARES.creator }} /><i className="buyback" style={{ flex: ENGINE_SHARES.buyback }} />
            <i className="operations" style={{ flex: ENGINE_SHARES.operations }} /><i className="protocol" style={{ flex: ENGINE_SHARES.protocol }} />
          </div>
          <dl className="fee-split-legend single">
            <div><dt><i className="creator" />Creators</dt><dd>{ENGINE_SHARES.creator / 100}%</dd></div>
            <div><dt><i className="buyback" />MUSEGOD buyback budget</dt><dd>{ENGINE_SHARES.buyback / 100}%</dd></div>
            <div><dt><i className="operations" />Platform operations</dt><dd>{ENGINE_SHARES.operations / 100}%</dd></div>
            <div><dt><i className="protocol" />Doppler protocol</dt><dd>{ENGINE_SHARES.protocol / 100}%</dd></div>
          </dl>
        </div>
      </section>
      <section className="card latest-burns" aria-labelledby="burns-title">
        <div className="card-head">
          <h2 id="burns-title" className="card-title">Latest burns</h2>
          {status.burnIndexCaughtUp && <span className="index-status live"><span aria-hidden="true" />Index caught up</span>}
        </div>
        {status.burns.length ? <ol>
          {status.burns.map((burn, index) => <li key={`${burn.hash}-${index}`}>
            <div><b className="mono">{amount(burn.amount)}</b> <span className="hint">MUSEGOD</span></div>
            <div className="hint">{burn.source === "swapper" ? "Buyback" : "Engine transfer"} · block <span className="mono">{Number(burn.blockNumber).toLocaleString("en-US")}</span></div>
            {explorer ? <a href={`${explorer}/tx/${burn.hash}`} target="_blank" rel="noreferrer" className="mono">{shortAddress(burn.hash)} ↗</a> : <code className="wrap">{burn.hash}</code>}
          </li>)}
        </ol> : <p className="hint">No dead-address transfer was found in this scan range.</p>}
        <p className="hint">Engine transfers and Swapper settlements verified against actual MUSEGOD receipts, indexed from block {status.burnScanFrom ?? "unavailable"} through {status.burnScanTo ?? "unavailable"}. {status.burnIndexCaughtUp ? "Index caught up to the confirmation boundary." : "History is catching up or temporarily unavailable."}</p>
      </section>
    </div>}
    {status?.engine && <section className="card waiting-card" aria-labelledby="waiting-title">
      <div>
        <h2 id="waiting-title" className="card-title">Waiting to burn</h2>
        <p className="card-sub">Anyone can move fees along and settle the next buyback. Callers pay gas; buyback traders get a 1.5% reference-price discount. A reserved budget is not a completed burn.</p>
      </div>
      <ol className="pipeline">
        <li className="stage">
          <span className="step-no">01 · IN POOLS</span>
          <b>{status.pools.length} {status.pools.length === 1 ? "pool" : "pools"}</b>
          <span className="hint">LP and hook fees waiting for collection</span>
          {status.pools.map((pool) => <div className="stage-item" key={pool.poolId}>
            <span className="mono">{pool.symbol} · {shortAddress(pool.address)}</span>
            {pool.claimable ? pool.claimable.map((asset) => <span key={asset.address} className="hint mono">{asset.symbol} LP {quantity(asset.lp, asset.decimals)} · Hook {quantity(asset.hook, asset.decimals)}</span>)
              : <span className="hint">Pending amounts unavailable; no zero balance is assumed.</span>}
            <span className="button-row">
              <button type="button" className="secondary" disabled={!enabled || busy} onClick={() => void run({ kind: "claim", poolId: pool.poolId })}>Collect</button>
              <button type="button" className="secondary" disabled={!enabled || busy} onClick={() => void run({ kind: "sync", poolId: pool.poolId })}>Sync received</button>
            </span>
          </div>)}
          {!status.pools.length && <span className="hint">No confirmed pools use this engine yet. Historical pools keep their original fee recipients.</span>}
        </li>
        <li className="stage">
          <span className="step-no">02 · FEE ENGINE</span>
          <b>{pending.length ? `${pending.length} ${pending.length === 1 ? "asset" : "assets"} pending` : "Nothing pending"}</b>
          <span className="hint">Collected fees awaiting conversion or forwarding</span>
          {pending.map((asset) => { const action = actionFor(asset); return <div className="stage-item" key={asset.address}>
            <span className="mono">{amount(asset.pending, asset.decimals)} {asset.symbol}</span>
            {asset.error && <span className="hint">{asset.error}</span>}
            <button type="button" className="secondary" disabled={action.disabled} onClick={action.run}>{action.label}</button>
          </div>; })}
        </li>
        <li className="stage dashed">
          <span className="step-no">02B · SPLITS ROUTE</span>
          <b className="mono">{amount(status.sourceAvailable)} WETH</b>
          <span className="hint">Unpriced fees, operator-controlled; forwarded publicly to the vault</span>
          <button type="button" className="secondary" disabled={!enabled || busy || !status.sourceAvailable || status.sourceAvailable === "0"} onClick={() => void run({ kind: "forward_source", amount: status.sourceAvailable! })}>Forward to vault</button>
        </li>
        <li className="stage halo">
          <span className="step-no">03 · BUDGET VAULT</span>
          <b className="mono">{amount(status.vaultWeth ?? null)} WETH</b>
          <span className="hint">Ready to buy MUSEGOD · {amount(status.vaultAvailable ?? null)} WETH available now</span>
          {!wallet.account ? <button type="button" className="primary" onClick={() => void wallet.connect()}>Connect wallet to process</button>
            : <button type="button" className="primary" disabled={!enabled || busy || !status.vaultAvailable || status.vaultAvailable === "0"} onClick={() => void previewBuyback()}>Preview MUSEGOD buyback</button>}
        </li>
      </ol>
      <div className="engine-guards">
        <div className="guard">
          <span className="guard-head"><b>Rolling limit · this 5-minute window</b><span className="mono">{amount(status.vaultSpent ?? null)} / {formatUnits(BUYBACK_WINDOW_CAP, 18)} WETH</span></span>
          {status.vaultSpent != null && <span className="limit-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Number(BigInt(status.vaultSpent) * 10_000n / BUYBACK_WINDOW_CAP) / 100)}%` }} /></span>}
          <span>Shared across all callers; spending older than five minutes rolls off.</span>
        </div>
        <div className={`guard${status.buybackWaitReason ? " warn" : ""}`}>
          <b>{status.buybackWaitReason ? "Buybacks waiting" : "Price guard"}</b>
          <span>{status.buybackWaitReason ?? "Spot, five-minute and thirty-minute pool prices must agree within 2%; a wider spread pauses only buybacks and fees remain held."}</span>
        </div>
      </div>
      {preview && <div className="buy-preview" aria-live="polite">
        <h3>{preview.label}</h3>
        <dl className="rows">
          <div><dt>To the dead address, at least</dt><dd>{preview.minimum}</dd></div>
          {preview.profit && <div><dt>Caller surplus before gas</dt><dd>{preview.profit}</dd></div>}
        </dl>
        <p className="hint">{clock < preview.expiresAt ? `Preview expires in ${Math.ceil((preview.expiresAt - clock) / 1000)} seconds. Your wallet will confirm the transaction.` : "Preview expired. Request a new preview."}</p>
        <div className="button-row">
          <button type="button" className="primary large" disabled={!enabled || busy || clock >= preview.expiresAt} onClick={() => void run(preview.action)}>Confirm transaction</button>
          <button type="button" className="secondary large" disabled={busy} onClick={() => setPreview(null)}>Dismiss</button>
        </div>
      </div>}
      {config?.blockReason && <p className="launch-blocked">{config.blockReason}</p>}
      <div className="engine-disclosures">
        <details className="disclosure boxed">
          <summary>Contracts</summary>
          <dl className="rows">
            <div><dt>Fee engine</dt><dd>{link(status.engine)}</dd></div>
            <div><dt>Swapper</dt><dd>{link(status.swapper)}</dd></div>
            <div><dt>Budget vault</dt><dd>{link(status.vault)}</dd></div>
            <div><dt>Asset price oracle</dt><dd>{link(status.assetOracle)}</dd></div>
            <div><dt>Operations treasury</dt><dd>{link(status.operationsTreasury)}</dd></div>
            <div><dt>Splits Automation (unpriced fees)</dt><dd>{link(status.automationReceiver)}</dd></div>
            <div><dt>Splits Treasury (Automation WETH)</dt><dd>{link(status.automationTreasury)}</dd></div>
            <div><dt>Fixed WETH forwarder</dt><dd>{link(status.wethForwarder)}</dd></div>
          </dl>
        </details>
        <details className="disclosure boxed">
          <summary>Pending feed replacements · {status.feedProposals?.length ?? 0}</summary>
          <p className="hint">The platform treasury can replace an existing asset price feed after seven days. It cannot withdraw funds or change the buyback destination through this oracle. This pricing authority can affect conversion value. The current feed stays active until the proposal is activated; activation still requires valid feed metadata and a fresh price, and issuer pauses remain enforced.</p>
          {!status.feedProposals?.length ? <p className="hint">No pending feed proposals at the displayed block.</p> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Asset</th><th>Current feed</th><th>Proposed feed</th><th>Earliest activation (UTC)</th><th>Time remaining</th></tr></thead><tbody>{status.feedProposals.map((proposal) => {
            const remaining = Math.max(0, Number(proposal.executableAt) - Math.floor(clock / 1000));
            return <tr key={proposal.token}><td>{proposal.symbol}</td><td>{link(proposal.currentFeed)}</td><td>{link(proposal.proposedFeed)}</td><td className="mono">{new Date(Number(proposal.executableAt) * 1000).toISOString()}</td><td>{remaining ? `${Math.floor(remaining / 86400)}d ${Math.floor(remaining % 86400 / 3600)}h ${Math.floor(remaining % 3600 / 60)}m ${remaining % 60}s` : "Timelock elapsed; awaiting activation"}</td></tr>;
          })}</tbody></table></div>}
        </details>
        <details className="disclosure boxed">
          <summary>Collected fees by asset · {tracked.length}</summary>
          {tracked.length === 0 ? <p className="hint">No fee receipts have been recorded yet.</p> : <div className="asset-ledger">{tracked.map((asset) => {
            const action = actionFor(asset);
            return <div key={asset.address} className="tile">
              <b>{asset.symbol}</b>
              <dl className="rows">
                <div><dt>Claimed from pools</dt><dd>{quantity(asset.claimed, asset.decimals)}</dd></div>
                <div><dt>Externally received, separately accounted</dt><dd>{quantity(asset.synced ?? null, asset.decimals)}</dd></div>
                <div><dt>Received, awaiting accounting</dt><dd>{quantity(asset.untracked ?? null, asset.decimals)}</dd></div>
                <div><dt>Pending processing</dt><dd>{quantity(asset.pending, asset.decimals)}</dd></div>
                <div><dt>{action.muse ? "Transferred directly to dead address" : action.weth ? "Forwarded to budget vault" : "Converted to WETH"}</dt><dd>{quantity(action.muse ? status.directBurned : action.weth ? asset.forwarded : asset.converted, asset.decimals)}</dd></div>
                <div><dt>Unpriced buyback fees forwarded to Automation</dt><dd>{quantity(asset.automationForwarded, asset.decimals)}</dd></div>
              </dl>
              {action.unpriced && <p className="hint">This asset has no configured price source. Its collected buyback allocation can be forwarded to the operator-controlled Splits Automation account. Forwarding is not a completed buyback or burn.</p>}
              {asset.error && <p className="hint">{asset.error}</p>}
            </div>;
          })}</div>}
        </details>
        <details className="disclosure boxed">
          <summary>Splits Treasury WETH forwarding</summary>
          <dl className="rows">
            <div><dt>Source treasury WETH balance</dt><dd>{quantity(status.sourceWeth)} WETH</dd></div>
            <div><dt>WETH allowance to the fixed forwarder</dt><dd>{quantity(status.sourceAllowance)} WETH</dd></div>
            <div><dt>Available to forward</dt><dd>{quantity(status.sourceAvailable)} WETH</dd></div>
            <div><dt>Total WETH forwarded from this treasury</dt><dd>{quantity(status.sourceForwarded)} WETH</dd></div>
          </dl>
          <p className="hint">Anyone can forward the smaller of this treasury's WETH balance and its approved allowance to the fixed budget vault. The authorization covers WETH held in this source treasury, including deposits whose origin is not proven to be platform fees. It grants no access to other tokens or the separate operations treasury. Forwarding is a WETH transfer, not a completed buyback or burn; the caller pays gas and receives no forwarding reward.</p>
          {!status.sourceDeployed || status.sourceAllowance === "0" ? <p className="hint">Waiting for source deployment and a human-approved WETH allowance in Splits. This page does not request or sign approvals.</p> : null}
          {status.sourceAuthorizationError ? <p className="hint" role="status">{status.sourceAuthorizationError}</p> : null}
        </details>
        <details className="disclosure boxed">
          <summary>How the engine works</summary>
          <p className="hint">Anyone can collect fees, convert supported paired assets to WETH, and settle MUSEGOD buybacks. Collected, converted and forwarded fees are separate from completed burns. Engine conversions require at least 99% of the on-chain reference value and use a five-minute processing window capped at 10% of its starting balance. Buyback fees with no configured price source go to the operator-controlled Splits Automation account. Assets with a stale or paused price source remain pending.</p>
          <p className="hint">Fees sent to Automation await external conversion to WETH and delivery to the Splits Treasury, then public forwarding to the budget vault. This page does not verify native rule execution, and external conversions do not inherit the engine's 99% reference-price floor. The operating allocation stays in the separate operations treasury; forwarded buyback fees do not receive another 80/20 split.</p>
          <p className="hint">All buybacks share a strict rolling limit of 0.01 WETH per five minutes. Prices differing by more than 2% across spot, five-minute and thirty-minute readings pause only buybacks. Fees remain held. These same-pool checks are not an independent market price.</p>
        </details>
      </div>
    </section>}
  </>;
}
