import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { formatUnits, type Hex } from "viem";
import { api } from "../lib/api";
import { BUYBACK_WETH, buybackAmountCandidates, buybackVaultAbi, type BuybackEngineStatus, type EngineAction, type EngineConversionQuote } from "../lib/buyback-engine";
import { explorerFor, sameAddress, shortAddress, type RuntimeConfig } from "../lib/config";
import { MUSEGOD_BUYBACK } from "../lib/fee-policy";
import { errorMessage } from "../lib/validation";
import { publicClient, useWallet } from "../lib/wallet";

type Preview = { action: EngineAction; expiresAt: number; label: string; minimum: string; profit?: string };
const quantity = (amount: string | null, decimals = 18) => amount === null ? "Unavailable" : formatUnits(BigInt(amount), decimals);

export default function BuybackEngine({ config }: { config: RuntimeConfig | null }) {
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
      try { const next = await api<BuybackEngineStatus>("/buyback/engine"); if (!cancelled) setStatus(next); }
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
      if (current === generation.current) { setMessage("Transaction confirmed. Refreshing on-chain balances…"); setRefresh((value) => value + 1); }
    } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function previewConversion(token: string, amount: string, symbol: string) {
    if (!enabled || !wallet.account || busy) return;
    const current = generation.current;
    setBusy(true); setError(""); setPreview(null);
    try {
      const result = await api<EngineConversionQuote>("/buyback/engine/quote", { token, amount, caller: wallet.account });
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
  return <section className="panel" aria-labelledby="buyback-engine-title">
    <div className="section-heading"><h2 id="buyback-engine-title">Public buyback engine</h2><button className="secondary" aria-label="Refresh buyback engine balances" disabled={busy} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} /></button></div>
    {!status ? <p role="status">Reading on-chain engine balances…</p> : !status.engine ? <p className="muted">{status.reason}</p> : <>
      {status.reason && <p className="muted" role="status">{status.reason}</p>}
      <p>Anyone can collect fees, convert supported paired assets to WETH, and settle MUSEGOD buybacks. Callers pay gas; buyback traders receive a 1.5% reference-price discount.</p>
      <dl className="buyback-facts">
        <div><dt>Fee engine</dt><dd>{explorer ? <a href={`${explorer}/address/${status.engine}`} target="_blank" rel="noreferrer">{status.engine}<ArrowUpRight size={14} /></a> : status.engine}</dd></div>
        <div><dt>Swapper</dt><dd>{explorer ? <a href={`${explorer}/address/${status.swapper}`} target="_blank" rel="noreferrer">{status.swapper}<ArrowUpRight size={14} /></a> : status.swapper}</dd></div>
        <div><dt>Operations treasury</dt><dd>{explorer ? <a href={`${explorer}/address/${status.operationsTreasury}`} target="_blank" rel="noreferrer">{status.operationsTreasury}<ArrowUpRight size={14} /></a> : status.operationsTreasury}</dd></div>
        <div><dt>Splits Automation account for unpriced buyback fees</dt><dd>{explorer ? <a href={`${explorer}/address/${status.automationReceiver}`} target="_blank" rel="noreferrer">{status.automationReceiver}<ArrowUpRight size={14} /></a> : status.automationReceiver}</dd></div>
        <div><dt>Splits Treasury receiving Automation WETH</dt><dd>{explorer ? <a href={`${explorer}/address/${status.automationTreasury}`} target="_blank" rel="noreferrer">{status.automationTreasury}<ArrowUpRight size={14} /></a> : status.automationTreasury}</dd></div>
        <div><dt>Fixed WETH forwarder</dt><dd>{explorer ? <a href={`${explorer}/address/${status.wethForwarder}`} target="_blank" rel="noreferrer">{status.wethForwarder}<ArrowUpRight size={14} /></a> : status.wethForwarder}</dd></div>
        <div><dt>WETH produced by fee conversions</dt><dd>{quantity(status.convertedWeth)} WETH</dd></div>
        <div><dt>WETH waiting for a buyback in the budget vault</dt><dd>{quantity(status.vaultWeth ?? null)} WETH</dd></div>
        <div><dt>MUSEGOD transferred directly by the engine to the dead address</dt><dd>{quantity(status.directBurned)} MUSEGOD</dd></div>
        <div><dt>Holdings read at block</dt><dd>{status.blockNumber}</dd></div>
      </dl>
      <p className="muted">Collected, converted and forwarded fees are separate from completed burns. Engine conversions require at least 99% of the on-chain reference value and use a five-minute processing window capped at 10% of its starting balance. Buyback fees with no configured price source go to the operator-controlled Splits Automation account. Assets with a stale or paused price source remain pending.</p>
      <p className="muted">Fees sent to Automation await external conversion to WETH and delivery to the Splits Treasury shown above, then public forwarding to the budget vault. This page does not verify native rule execution, and external conversions do not inherit the engine's 99% reference-price floor. The operating allocation stays in the separate operations treasury; forwarded buyback fees do not receive another 80/20 split.</p>
      <p className="muted">All buybacks share a strict rolling limit of 0.01 WETH per five minutes. Prices differing by more than 2% across spot, five-minute and thirty-minute readings pause only buybacks. Fees remain held. These same-pool checks are not an independent market price.</p>
      {status.buybackWaitReason && <p role="status">{status.buybackWaitReason}</p>}
      <p className="muted">The platform treasury can replace an existing asset price feed after seven days. It cannot withdraw funds or change the buyback destination through this oracle. This pricing authority can affect conversion value.</p>
      <h3>Pending feed replacements</h3>
      <p className="muted">The current feed stays active until the seven-day proposal is activated. Activation still requires valid feed metadata and a fresh price; issuer pauses remain enforced.</p>
      {!status.feedProposals?.length ? <p className="muted">No pending feed proposals at the displayed block.</p> : <div className="table-wrap"><table><thead><tr><th>Asset</th><th>Current feed</th><th>Proposed feed</th><th>Earliest activation (UTC)</th><th>Time remaining</th></tr></thead><tbody>{status.feedProposals.map((proposal) => {
        const remaining = Math.max(0, Number(proposal.executableAt) - Math.floor(clock / 1000));
        const address = (value: string) => explorer ? <a href={`${explorer}/address/${value}`} target="_blank" rel="noreferrer">{value}</a> : value;
        return <tr key={proposal.token}><td>{proposal.symbol}</td><td>{address(proposal.currentFeed)}</td><td>{address(proposal.proposedFeed)}</td><td>{new Date(Number(proposal.executableAt) * 1000).toISOString()}</td><td>{remaining ? `${Math.floor(remaining / 86400)}d ${Math.floor(remaining % 86400 / 3600)}h ${Math.floor(remaining % 3600 / 60)}m ${remaining % 60}s` : "Timelock elapsed; awaiting activation"}</td></tr>;
      })}</tbody></table></div>}
      {!wallet.account ? <button className="primary" onClick={() => void wallet.connect()}>Connect wallet to process fees</button> : <button className="primary" disabled={!enabled || busy || !status.vaultAvailable || status.vaultAvailable === "0"} onClick={() => void previewBuyback()}>Preview MUSEGOD buyback</button>}
      {config?.blockReason && <p className="muted">{config.blockReason}</p>}
      <h3>Splits Treasury WETH forwarding</h3>
      <dl className="buyback-facts">
        <div><dt>Source treasury WETH balance</dt><dd>{quantity(status.sourceWeth)} WETH</dd></div>
        <div><dt>WETH allowance to the fixed forwarder</dt><dd>{quantity(status.sourceAllowance)} WETH</dd></div>
        <div><dt>Available to forward</dt><dd>{quantity(status.sourceAvailable)} WETH</dd></div>
        <div><dt>Total WETH forwarded from this treasury</dt><dd>{quantity(status.sourceForwarded)} WETH</dd></div>
      </dl>
      <p className="muted">Anyone can forward the smaller of this treasury's WETH balance and its approved allowance to the fixed budget vault. The authorization covers WETH held in this source treasury, including deposits whose origin is not proven to be platform fees. It grants no access to other tokens or the separate operations treasury. Forwarding is a WETH transfer, not a completed buyback or burn; the caller pays gas and receives no forwarding reward.</p>
      {!status.sourceDeployed || status.sourceAllowance === "0" ? <p className="muted">Waiting for source deployment and a human-approved WETH allowance in Splits. This page does not request or sign approvals.</p> : null}
      <button className="secondary" disabled={!enabled || busy || !status.sourceAvailable || status.sourceAvailable === "0"} onClick={() => void run({ kind: "forward_source", amount: status.sourceAvailable! })}>Forward approved source WETH to vault</button>
      <h3>Fee collection</h3>
      {status.pools.length ? status.pools.map((pool) => <div className="fee-allocation" key={pool.poolId}>
        <p>{pool.symbol} · {shortAddress(pool.address)}</p>
        {pool.claimable ? <dl>{pool.claimable.map((asset) => <div key={asset.address}><dt>{asset.symbol} pending collection</dt><dd>LP {quantity(asset.lp, asset.decimals)} · Hook {quantity(asset.hook, asset.decimals)}</dd></div>)}</dl> : <p className="muted">Pending collection amounts are unavailable. No zero balance is assumed.</p>}
        <button className="secondary" disabled={!enabled || busy} onClick={() => void run({ kind: "claim", poolId: pool.poolId })}>Collect pool fees</button>
        <button className="secondary" disabled={!enabled || busy} onClick={() => void run({ kind: "sync", poolId: pool.poolId })}>Account for externally received fees</button>
      </div>) : <p className="muted">No confirmed pools use this engine yet. Historical pools keep their original fee recipients.</p>}
      <h3>Collected fees</h3>
      {status.assets.filter((asset) => asset.pending !== "0" || asset.claimed !== "0" || (asset.synced ?? "0") !== "0" || (asset.untracked ?? "0") !== "0").length === 0 ? <p className="muted">No fee receipts have been recorded yet.</p> : status.assets.filter((asset) => asset.pending !== "0" || asset.claimed !== "0" || (asset.synced ?? "0") !== "0" || (asset.untracked ?? "0") !== "0").map((asset) => {
        const weth = sameAddress(asset.address, BUYBACK_WETH), muse = sameAddress(asset.address, MUSEGOD_BUYBACK.tokenAddress);
        const unpriced = asset.pricing === "unsupported_static" && !weth && !muse;
        return <div className="fee-allocation" key={asset.address}>
          <h4>{asset.symbol}</h4>
          <dl><div><dt>Claimed from pools</dt><dd>{quantity(asset.claimed, asset.decimals)}</dd></div><div><dt>Externally received, separately accounted</dt><dd>{quantity(asset.synced ?? null, asset.decimals)}</dd></div><div><dt>Received, awaiting accounting</dt><dd>{quantity(asset.untracked ?? null, asset.decimals)}</dd></div><div><dt>Pending processing</dt><dd>{quantity(asset.pending, asset.decimals)}</dd></div><div><dt>{muse ? "Transferred directly to dead address" : weth ? "Forwarded to budget vault" : "Converted to WETH"}</dt><dd>{quantity(muse ? status.directBurned : weth ? asset.forwarded : asset.converted, asset.decimals)}</dd></div><div><dt>Unpriced buyback fees forwarded to Automation</dt><dd>{quantity(asset.automationForwarded, asset.decimals)}</dd></div></dl>
          {unpriced && <p className="muted">This asset has no configured price source. Its collected buyback allocation can be forwarded to the operator-controlled Splits Automation account. Forwarding is not a completed buyback or burn.</p>}
          {asset.error && <p className="muted">{asset.error}</p>}
          {asset.pending !== "0" && <button className="secondary" disabled={!enabled || busy || asset.pricing === "unknown" || !!asset.error || (!muse && !unpriced && (asset.available === "0" || !asset.referenceWeth))} onClick={() => muse ? void run({ kind: "burn", amount: asset.pending }) : unpriced ? void run({ kind: "release_unpriced", token: asset.address, amount: asset.pending }) : weth ? void run({ kind: "forward", amount: asset.available }) : void previewConversion(asset.address, asset.available, asset.symbol)}>{muse ? "Transfer fees to dead address" : unpriced ? "Forward unpriced buyback fees to Automation" : weth ? "Forward available WETH" : "Preview WETH conversion"}</button>}
        </div>;
      })}
      <h3>Confirmed dead-address transfers</h3>
      <p className="muted">Recent engine transfers and Swapper settlements verified against actual MUSEGOD receipts, indexed from block {status.burnScanFrom ?? "unavailable"} through {status.burnScanTo ?? "unavailable"}. {status.burnIndexCaughtUp ? "Index caught up to the confirmation boundary." : "History is catching up or temporarily unavailable."} ERC-20 totalSupply is unchanged.</p>
      {status.burns.length ? status.burns.map((burn, index) => <div className="fee-allocation" key={`${burn.hash}-${index}`}>
        <span>{quantity(burn.amount)} MUSEGOD · {burn.source === "swapper" ? "Buyback" : "Engine transfer"}</span>{explorer ? <a href={`${explorer}/tx/${burn.hash}`} target="_blank" rel="noreferrer">{shortAddress(burn.hash)}<ArrowUpRight size={14} /></a> : <code className="wrap">{burn.hash}</code>}
      </div>) : <p className="muted">No dead-address transfer was found in this scan range.</p>}
    </>}
    {preview && <div className="fee-allocation" aria-live="polite"><h3>{preview.label}</h3><p>{preview.minimum}</p>{preview.profit && <p>{preview.profit}</p>}<p className="muted">{clock < preview.expiresAt ? `Preview expires in ${Math.ceil((preview.expiresAt - clock) / 1000)} seconds. Your wallet will confirm the transaction.` : "Preview expired. Request a new preview."}</p><button className="primary" disabled={!enabled || busy || clock >= preview.expiresAt} onClick={() => void run(preview.action)}>Confirm transaction</button><button className="secondary" disabled={busy} onClick={() => setPreview(null)}>Dismiss</button></div>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    {hash && (explorer ? <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={14} /></a> : <code className="wrap">{hash}</code>)}
  </section>;
}
