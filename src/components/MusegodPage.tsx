import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, Copy, LoaderCircle, RefreshCw, Wallet } from "lucide-react";
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
  const [clock, setClock] = useState(Date.now), [copied, setCopied] = useState(false), [imageFailed, setImageFailed] = useState(false);

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
    const timer = setInterval(() => setClock(Date.now()), 1000);
    const update = () => setRevision((n) => n + 1);
    window.addEventListener("musegod:transactions", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("musegod:transactions", update);
    };
  }, []);
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
  if (config && !musegodNetwork(config)) return <section className="panel">
    <h1>MUSEGOD is available on Robinhood Chain</h1>
    <p className="body-copy">This deployment does not support the MUSEGOD trading page.</p>
    <a href="/" onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault(); navigate("/");
    } }}>Back to explore</a>
  </section>;
  return (
    <>
      <a href="/" className="back-link" onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); navigate("/"); }
      }}>← Back to explore</a>
      <div className="token-title">
        <span className="token-icon">
          {imageFailed ? "MU" : <img src={MUSEGOD.image} alt="" onError={() => setImageFailed(true)} />}
        </span>
        <div><h1>{MUSEGOD.name}</h1><p>${MUSEGOD.symbol} · WETH pair</p></div>
        <span className="pill">{network}</span>
      </div>
      <div className="token-toolbar">
        <button className="text-button" onClick={() => {
          void navigator.clipboard.writeText(MUSEGOD.token).then(() => setCopied(true))
            .catch(() => setError("Copy failed. Copy the address from the contract details."));
        }}><Copy size={13} /> {copied ? "Copied" : shortAddress(MUSEGOD.token)}</button>
        <a href={MUSEGOD.sourceUrl} target="_blank" rel="noreferrer" className="text-button">View on Pools <ArrowUpRight size={13} /></a>
      </div>
      <div className="detail-layout token-trading-layout musegod-trading-layout">
        <div>
          <TokenMarket token={{ address: MUSEGOD.token, symbol: MUSEGOD.symbol, mode: config?.mode ?? "robinhood" }}
            kind="musegod" refreshKey={`${hash ?? ""}:${revision}`} />
          <section className="panel">
            <h2>About {MUSEGOD.name}</h2>
            <p className="body-copy">{MUSEGOD.description}</p>
            <dl className="contract-list">
              <div><dt>Token contract</dt><dd>{explorer ? <a href={`${explorer}/token/${MUSEGOD.token}`} target="_blank" rel="noreferrer">{shortAddress(MUSEGOD.token)} ↗</a> : <code>{shortAddress(MUSEGOD.token)}</code>}</dd></div>
              <div><dt>Trading pool</dt><dd>{explorer ? <a href={`${explorer}/address/${MUSEGOD.pool}`} target="_blank" rel="noreferrer">SushiSwap v3 ↗</a> : "SushiSwap v3"}</dd></div>
              <div><dt>Pool fee</dt><dd>1% · Included in the quote</dd></div>
              <div><dt>Total supply</dt><dd className="musegod-amount" title={exactAmount(info?.totalSupply ?? null)}>{amountText(info?.totalSupply ?? null)}</dd></div>
            </dl>
            <p className="asset-note">ETH is wrapped to WETH when buying. Selling unwraps WETH to ETH in the same transaction. This site adds no trading fee.</p>
          </section>
        </div>
        <section className="panel trade-panel" id="trade">
          <div className="trade-panel-heading"><h2>Trade {MUSEGOD.symbol}</h2><span className="pill">ETH ↔ MUSEGOD</span></div>
          <div className="trade-tabs">
            <button aria-pressed={side === "buy"} className={side === "buy" ? "active" : ""} disabled={busy} onClick={() => setSide("buy")}>Buy</button>
            <button aria-pressed={side === "sell"} className={side === "sell" ? "active sell" : ""} disabled={busy} onClick={() => setSide("sell")}>Sell</button>
          </div>
          {blockReason && <div className="notice" role="status"><span>{blockReason}</span></div>}
          {infoError && <div className="notice error" role="alert"><span>{infoError}</span></div>}
          <label className="trade-input"><span>You pay <b>{inputSymbol}</b></span>
            <input aria-label="Trade input amount" inputMode="decimal" value={amount} disabled={busy} placeholder="0.00" onChange={(event) => setAmount(event.target.value)} />
            <span className="balance">Balance: <span className="musegod-amount" title={exactAmount(balance)}>{amountText(balance)} {inputSymbol}</span></span>
          </label>
          {side === "sell" && <div className="quick-amounts">
            {[25, 50, 75, 100].map((percent) => <button key={percent} disabled={busy || balance === null}
              onClick={() => balance !== null && setAmount(formatUnits(balance * BigInt(percent) / 100n, 18))}>{percent === 100 ? "Max" : `${percent}%`}</button>)}
          </div>}
          <div className="trade-arrow"><ArrowDown size={16} /></div>
          <div className="receive"><span>You receive (estimated) <b>{outputSymbol}</b></span><strong className="musegod-amount" title={exactAmount(quote?.amountOut ?? null)}>{amountText(quote?.amountOut ?? null)}</strong></div>
          <label className="slippage">Maximum slippage
            <select aria-label="Maximum trade slippage" value={slippage} disabled={busy} onChange={(event) => setSlippage(Number(event.target.value))}>
              <option value={50}>0.5%</option><option value={100}>1%</option><option value={200}>2%</option><option value={500}>5%</option>
            </select>
          </label>
          {quote && <div className="quote-summary">
            <div><span>Minimum received</span><b className="musegod-amount" title={exactAmount(quote.minAmountOut)}>{amountText(quote.minAmountOut)} {outputSymbol}</b></div>
            <div><span>Quote expires in</span><b>{Math.max(0, Math.ceil((quote.expiresAt - clock) / 1000))} seconds</b></div>
          </div>}
          <button className="secondary full" disabled={busy || !amount || !config || !musegodNetwork(config)} onClick={() => void getQuote()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Get on-chain quote
          </button>
          {wallet.account ? <button className="primary full"
            disabled={busy || !quote || clock >= quote.expiresAt || !config?.writesEnabled || !info?.tradeEnabled || wallet.chainId !== config?.chainId}
            onClick={() => void execute()}>Confirm {side === "buy" ? "Buy" : "Sell"} <ArrowUpRight size={16} /></button>
            : <button className="primary full" disabled={wallet.connecting} onClick={() => void wallet.connect()}><Wallet size={16} /> Connect wallet to trade</button>}
          {balanceError && <div className="notice error" role="alert"><span>Could not load balance: {balanceError}</span></div>}
          {error && <div className="notice error" role="alert"><span>{error}</span></div>}
          {progress && <div className="notice" role="status"><span>{progress}</span></div>}
          {hash && <div className="musegod-transaction" role="status">{confirmed ? "Confirmed" : "Submitted · Check wallet transaction history"}{" "}
            {explorer ? <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{shortAddress(hash)} ↗</a> : <code>{shortAddress(hash)}</code>}
          </div>}
          <p className="asset-note">Keep ETH available for network fees. Selling may first require approval for the exact MUSEGOD amount. Each step needs your wallet confirmation.</p>
          <button className="text-button full" disabled={busy} onClick={() => setRevision((n) => n + 1)}><RefreshCw size={13} /> Refresh token verification and balances</button>
        </section>
      </div>
    </>
  );
}
