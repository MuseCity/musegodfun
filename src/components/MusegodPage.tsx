import { quoteNow } from "../lib/quote-clock";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, CircleAlert, Copy, Crown, Flame, Info, LoaderCircle, RefreshCw, Share2, Sparkles, TriangleAlert, Wallet } from "lucide-react";
import { FEE_SHARES } from "../lib/fee-policy";
import { burnShare, compactAmount, useMusegodBurn } from "../lib/musegod-burn";
import { feePercent } from "../lib/format";
import ShareDialog from "./ShareDialog";
import SlippageControl from "./SlippageControl";
import { formatUnits, type Hash } from "viem";
import { api } from "../lib/api";
import { explorerFor, networkName, shortAddress, type RuntimeConfig } from "../lib/config";
import { MUSEGOD, assertMusegodQuote, musegodNetwork, type MusegodInfo, type MusegodQuote } from "../lib/musegod";
import { errorMessage, parseAmount } from "../lib/validation";
import { useWallet } from "../lib/wallet";
import TokenMarket from "./TokenMarket";

const exactAmount = (raw: bigint | string | null) => raw === null ? undefined : formatUnits(BigInt(raw), 18);
const amountText = (raw: bigint | string | null) => {
  if (raw === null) return "—";
  const amount = Number(exactAmount(raw));
  return amount > 0 && amount < 0.00000001 ? "< 0.00000001"
    : amount.toLocaleString("en-US", { maximumFractionDigits: 8 });
};

export default function MusegodPage({ config, navigate }: {
  config: RuntimeConfig | null;
  navigate: (path: string) => void;
}) {
  const wallet = useWallet(), generation = useRef(0);
  const [info, setInfo] = useState<MusegodInfo | null>(null), [infoError, setInfoError] = useState("");
  const [revision, setRevision] = useState(0), [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState(""), [slippage, setSlippage] = useState(100);
  const [quote, setQuote] = useState<MusegodQuote | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [progress, setProgress] = useState("");
  const [hash, setHash] = useState<Hash | null>(null), [confirmed, setConfirmed] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null), [balanceError, setBalanceError] = useState("");
  const [clock, setClock] = useState(quoteNow), [copied, setCopied] = useState(false), [imageFailed, setImageFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const burn = useMusegodBurn(revision);

  useEffect(() => {
    let active = true;
    setInfo(null);
    setInfoError("");
    if (config && !musegodNetwork(config)) return () => { active = false; };
    api<MusegodInfo>("/musegod")
      .then((next) => { if (active) setInfo(next); })
      .catch((failure) => { if (active) setInfoError(errorMessage(failure)); });
    return () => { active = false; };
  }, [config?.chainId, config?.mode, config?.deploymentChainId, revision]);
  useEffect(() => {
    setClock(quoteNow(quote ?? undefined));
    const timer = setInterval(() => setClock(quoteNow(quote ?? undefined)), 1000);
    const update = () => setRevision((n) => n + 1);
    window.addEventListener("musegod:transactions", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("musegod:transactions", update);
    };
  }, [quote]);
  useEffect(() => {
    generation.current++;
    setQuote(null);
    setBusy(false);
    setError("");
    setProgress("");
    setHash(null);
    setConfirmed(false);
    return () => { generation.current++; };
  }, [amount, side, slippage, wallet.revision, config?.chainId, config?.mode, config?.deploymentChainId]);
  useEffect(() => {
    let active = true;
    setBalance(null);
    setBalanceError("");
    if (wallet.account && config && musegodNetwork(config) && wallet.chainId === config.chainId) {
      (side === "buy" ? wallet.balanceNative() : wallet.balance(MUSEGOD.token))
        .then((next) => { if (active) setBalance(next); })
        .catch((failure) => { if (active) setBalanceError(errorMessage(failure)); });
    }
    return () => { active = false; };
  }, [wallet.account, wallet.chainId, wallet.revision, side, revision, config?.chainId, config?.mode, config?.deploymentChainId]);

  async function getQuote() {
    if (!config) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setProgress("");
    setQuote(null);
    setHash(null);
    setConfirmed(false);
    try {
      const next = await api<MusegodQuote>("/musegod/quote", { side, amount, slippageBps: slippage });
      assertMusegodQuote(next, config);
      if (next.side !== side || BigInt(next.amountIn) !== parseAmount(amount, 18) || next.slippageBps !== slippage)
        throw new Error("The quote does not match your trade. Request a new quote.");
      if (request === generation.current) setQuote(next);
    } catch (failure) {
      if (request === generation.current) setError(errorMessage(failure));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  async function execute() {
    if (!quote || !config || !info?.tradeEnabled) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await wallet.tradeMusegod(quote, config,
        (message) => { if (request === generation.current) setProgress(message); },
        (submitted) => {
          if (request === generation.current) {
            setQuote(null);
            setHash(submitted);
            setConfirmed(false);
            setProgress("Transaction submitted. Waiting for on-chain confirmation.");
          }
        });
      if (request === generation.current) {
        setHash(result);
        setQuote(null);
        setConfirmed(true);
        setProgress("Transaction confirmed");
        setRevision((n) => n + 1);
      }
    } catch (failure) {
      if (request === generation.current) {
        setError(errorMessage(failure));
        setProgress("");
      }
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  const network = config ? networkName(config) : "Robinhood Chain";
  const explorer = config ? explorerFor(config) : "https://robinhoodchain.blockscout.com";
  const inputSymbol = side === "buy" ? "ETH" : MUSEGOD.symbol;
  const outputSymbol = side === "buy" ? MUSEGOD.symbol : "ETH";
  const blockReason = info?.tradeBlockReason || config?.blockReason ||
    (!info ? infoError ? "Token verification is unavailable. Refresh to retry." : "Loading token verification…" : null);
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
              void navigator.clipboard.writeText(MUSEGOD.token).then(() => setCopied(true))
                .catch(() => setError("Copy failed. Copy the address from the contract details."));
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
        <section className="card trade-panel" id="trade" aria-labelledby="musegod-trade-title">
          <div className="trade-panel-heading"><h2 id="musegod-trade-title" className="card-title">Trade {MUSEGOD.symbol}</h2><span className="pill">ETH ↔ MUSEGOD</span></div>
          <div className="trade-tabs" role="group" aria-label="Trade side">
            <button type="button" aria-pressed={side === "buy"} className={side === "buy" ? "active" : ""} disabled={busy} onClick={() => setSide("buy")}>Buy</button>
            <button type="button" aria-pressed={side === "sell"} className={side === "sell" ? "active sell" : ""} disabled={busy} onClick={() => setSide("sell")}>Sell</button>
          </div>
          {blockReason && <div className="notice warning" role="status"><TriangleAlert size={17} aria-hidden="true" /><span>{blockReason}</span></div>}
          {infoError && <div className="notice error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{infoError}</span></div>}
          <label className="trade-box pay">
            <span className="trade-box-head"><span>You pay <b>{inputSymbol}</b></span>
              <span className="balance">Balance: <b className="musegod-amount" title={exactAmount(balance)}>{amountText(balance)} {inputSymbol}</b></span></span>
            <input aria-label="Trade input amount" inputMode="decimal" value={amount} disabled={busy} placeholder="0.00" onChange={(event) => setAmount(event.target.value)} />
          </label>
          {side === "sell" && <div className="quick-amounts">
            {[25, 50, 75, 100].map((percent) => <button type="button" key={percent} disabled={busy || balance === null}
              onClick={() => balance !== null && setAmount(formatUnits(balance * BigInt(percent) / 100n, 18))}>{percent === 100 ? "Max" : `${percent}%`}</button>)}
          </div>}
          <div className="trade-arrow" aria-hidden="true"><ArrowDown size={16} /></div>
          <div className="trade-box receive"><span className="trade-box-head"><span>You receive (estimated) <b>{outputSymbol}</b></span></span>
            <strong className="musegod-amount" title={exactAmount(quote?.amountOut ?? null)}>{amountText(quote?.amountOut ?? null)}</strong></div>
          <SlippageControl value={slippage} disabled={busy} onChange={setSlippage} />
          {quote && <dl className="rows boxed quote-summary">
            <div><dt>Minimum received</dt><dd className="musegod-amount" title={exactAmount(quote.minAmountOut)}>{amountText(quote.minAmountOut)} {outputSymbol}</dd></div>
            <div><dt>Quote expires in</dt><dd>{Math.max(0, Math.ceil((quote.expiresAt - clock) / 1000))} seconds</dd></div>
          </dl>}
          <button type="button" className="secondary full trade-quote" disabled={busy || !amount || !config || !musegodNetwork(config)} onClick={() => void getQuote()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Get on-chain quote
          </button>
          {wallet.account ? <button type="button" className="primary large full"
            disabled={busy || !quote || clock >= quote.expiresAt || !config?.writesEnabled || !info?.tradeEnabled || wallet.chainId !== config?.chainId}
            onClick={() => void execute()}>Confirm {side === "buy" ? "Buy" : "Sell"} <ArrowUpRight size={16} /></button>
            : <button type="button" className="primary large full" disabled={wallet.connecting} onClick={() => void wallet.connect()}><Wallet size={16} /> Connect wallet to trade</button>}
          {balanceError && <div className="notice error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>Could not load balance: {balanceError}</span></div>}
          {error && <div className="notice error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span></div>}
          {progress && <div className="notice" role="status"><Info size={17} aria-hidden="true" /><span>{progress}</span></div>}
          {hash && <div className="musegod-transaction" role="status">{confirmed ? "Confirmed" : "Submitted · Check wallet transaction history"}{" "}
            {explorer ? <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{shortAddress(hash)} ↗</a> : <code>{shortAddress(hash)}</code>}
          </div>}
          <p className="trade-note">Keep some ETH for network fees. ETH is wrapped and unwrapped in the same transaction. Selling may first require approval for the exact MUSEGOD amount. Each step needs your wallet confirmation.</p>
          <button type="button" className="text-button full" disabled={busy} onClick={() => setRevision((n) => n + 1)}><RefreshCw size={13} /> Refresh token verification and balances</button>
        </section>
      </div>
    </>
  );
}
