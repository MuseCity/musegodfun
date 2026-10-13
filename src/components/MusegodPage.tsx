import { useState } from "react";
import { ArrowRight, Check, CircleAlert, Copy, Crown, Flame, Share2, Sparkles } from "lucide-react";
import { FEE_SHARES } from "../lib/fee-policy";
import { burnShare, compactAmount, useMusegodBurn } from "../lib/musegod-burn";
import { feePercent } from "../lib/format";
import ShareDialog from "./ShareDialog";
import MusegodTradePanel, { amountText, exactAmount, useMusegodInfo } from "./MusegodTradePanel";
import { formatUnits, type Hash } from "viem";
import { explorerFor, networkName, shortAddress, type RuntimeConfig } from "../lib/config";
import { MUSEGOD, musegodNetwork } from "../lib/musegod";
import TokenMarket from "./TokenMarket";

export default function MusegodPage({ config, navigate }: {
  config: RuntimeConfig | null;
  navigate: (path: string) => void;
}) {
  const musegod = useMusegodInfo(config), { info, revision } = musegod;
  const [hash, setHash] = useState<Hash | null>(null), [copyError, setCopyError] = useState("");
  const [copied, setCopied] = useState(false), [imageFailed, setImageFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const burn = useMusegodBurn(revision);

  const network = config ? networkName(config) : "Robinhood Chain";
  const explorer = config ? explorerFor(config) : "https://robinhoodchain.blockscout.com";
  if (config && !musegodNetwork(config)) return <section className="card not-found">
    <h1 className="page-title">MUSEGOD is available on Robinhood Chain</h1>
    <p className="body-copy">This deployment does not support the MUSEGOD trading page.</p>
    <a href="/" onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault(); navigate("/");
    } }}>Back to explore</a>
  </section>;
  const share = burn.data ? burnShare(burn.data) : null;
  const burnMetric = burn.data
    ? { label: "Total burned", value: `${share === null ? "—" : `${share.toFixed(2)}%`} · ${compactAmount(burn.data.burned)}`,
      title: `${formatUnits(burn.data.burned, 18)} MUSEGOD held by the dead address at block ${burn.data.blockNumber}` }
    : { label: "Total burned", value: burn.error ? "Unavailable" : "Reading…" };
  return (
    <>
      <div className="token-header musegod-header">
        <span className="token-icon xl featured" aria-hidden="true">
          {imageFailed ? "MU" : <img src={MUSEGOD.image} alt="" onError={() => setImageFailed(true)} />}
        </span>
        <div className="token-header-main">
          <div className="token-header-title">
            <h1><Crown className="crown" size={30} aria-hidden="true" /> {MUSEGOD.name}</h1>
            <span className="pill">{network}</span>
          </div>
          <div className="token-header-line">
            <span className="token-header-pair">${MUSEGOD.symbol} · WETH pair</span>
            <button type="button" className="copy-chip" aria-label={copied ? "Token contract address copied" : "Copy token contract address"} onClick={() => {
              void navigator.clipboard.writeText(MUSEGOD.token).then(() => { setCopied(true); setCopyError(""); })
                .catch(() => setCopyError("Copy failed. Copy the address from the contract details."));
            }}>{copied ? <Check size={14} /> : <Copy size={14} />}<span className="mono">{copied ? "Copied" : shortAddress(MUSEGOD.token)}</span></button>
            <span className="social-links"><a href={MUSEGOD.sourceUrl} target="_blank" rel="noreferrer">View on Pools ↗</a></span>
          </div>
          <div className="token-header-meta">
            <span className="chip sm raised"><Sparkles size={12} />Featured</span>
            <span className="chip sm sunken mono">1% pool fee · no site fee</span>
            <span>SushiSwap v3 · native ETH in and out</span>
          </div>
        </div>
        <button type="button" className="secondary token-share" onClick={() => setSharing(true)}><Share2 size={16} />Share</button>
      </div>
      {copyError && <div className="notice error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{copyError}</span></div>}
      {sharing && <ShareDialog name={MUSEGOD.name} url={`${location.origin}/token/robinhood/${MUSEGOD.token}`}
        detail={`$${MUSEGOD.symbol} · WETH pair · 1% pool`}
        icon={<span className="token-icon featured" aria-hidden="true"><img src={MUSEGOD.image} alt="" /></span>}
        onClose={() => setSharing(false)} />}
      <div className="detail-layout">
        <div className="detail-main">
          <TokenMarket token={{ address: MUSEGOD.token, symbol: MUSEGOD.symbol, mode: config?.mode ?? "robinhood" }}
            kind="musegod" refreshKey={`${hash ?? ""}:${revision}`} metric={burnMetric} />
          <section className="card about-card" aria-labelledby="musegod-about">
            <h2 id="musegod-about" className="card-title">About {MUSEGOD.name}</h2>
            <p className="body-copy">{MUSEGOD.description}</p>
            <div className="about-facts">
              <span>Pool {explorer ? <a href={`${explorer}/address/${MUSEGOD.pool}`} target="_blank" rel="noreferrer">SushiSwap v3 ↗</a> : "SushiSwap v3"}</span>
              <span>Supply <span className="mono" title={exactAmount(info?.totalSupply ?? null)}>{amountText(info?.totalSupply ?? null)}</span></span>
            </div>
            <dl className="rows boxed">
              <div><dt>Token contract</dt><dd>{explorer ? <a href={`${explorer}/token/${MUSEGOD.token}`} target="_blank" rel="noreferrer">{shortAddress(MUSEGOD.token)} ↗</a> : <code>{shortAddress(MUSEGOD.token)}</code>}</dd></div>
              <div><dt>Trading pool</dt><dd>{explorer ? <a href={`${explorer}/address/${MUSEGOD.pool}`} target="_blank" rel="noreferrer">SushiSwap v3 ↗</a> : "SushiSwap v3"}</dd></div>
              <div><dt>Pool fee</dt><dd className="sans">1% · Included in the quote</dd></div>
              <div><dt>Total supply</dt><dd className="musegod-amount" title={exactAmount(info?.totalSupply ?? null)}>{amountText(info?.totalSupply ?? null)}</dd></div>
            </dl>
            <p className="hint">ETH is wrapped to WETH when buying. Selling unwraps WETH to ETH in the same transaction. This site adds no trading fee.</p>
            <div className="callout">
              <Flame size={18} aria-hidden="true" />
              <span><b>{feePercent(FEE_SHARES.buyback)}</b> of every new launch’s trading fee funds MUSEGOD buybacks; purchased MUSEGOD goes to the dead address.</span>
              <a href="/buyback" onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); navigate("/buyback"); } }}>Buyback and burn <ArrowRight size={14} /></a>
            </div>
          </section>
        </div>
        <MusegodTradePanel config={config} musegod={musegod} onHash={setHash} />
      </div>
    </>
  );
}
