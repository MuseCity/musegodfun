import { quoteNow } from "../lib/quote-clock";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, CircleAlert, Info, LoaderCircle, RefreshCw, TriangleAlert, Wallet } from "lucide-react";
import SlippageControl from "./SlippageControl";
import { formatUnits, type Hash } from "viem";
import { api } from "../lib/api";
import { explorerFor, shortAddress, type RuntimeConfig } from "../lib/config";
import { MUSEGOD, assertMusegodQuote, musegodNetwork, type MusegodInfo, type MusegodQuote } from "../lib/musegod";
import { errorMessage, parseAmount } from "../lib/validation";
import { useWallet } from "../lib/wallet";

export const exactAmount = (raw: bigint | string | null) => raw === null ? undefined : formatUnits(BigInt(raw), 18);
export const amountText = (raw: bigint | string | null) => {
  if (raw === null) return "—";
  const amount = Number(exactAmount(raw));
  return amount > 0 && amount < 0.00000001 ? "< 0.00000001"
    : amount.toLocaleString("en-US", { maximumFractionDigits: 8 });
};

export type MusegodState = { info: MusegodInfo | null; infoError: string; revision: number; refresh: () => void };
/** MUSEGOD's verified token info, re-read on `refresh` and after any wallet transaction. */
export function useMusegodInfo(config: RuntimeConfig | null): MusegodState {
  const [info, setInfo] = useState<MusegodInfo | null>(null), [infoError, setInfoError] = useState("");
  const [revision, setRevision] = useState(0);
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
    const update = () => setRevision((n) => n + 1);
    window.addEventListener("musegod:transactions", update);
    return () => window.removeEventListener("musegod:transactions", update);
  }, []);
  return { info, infoError, revision, refresh: () => setRevision((n) => n + 1) };
}

/** The ETH ↔ MUSEGOD trade panel of the MUSEGOD page, also shown on a MUSEGOD-paired coin's page to buy MUSEGOD first. */
export default function MusegodTradePanel({ config, musegod, title = `Trade ${MUSEGOD.symbol}`, id = "trade", titleId = "musegod-trade-title",
  className = "", onHash, onConfirmed }: {
  config: RuntimeConfig | null;
  musegod: MusegodState;
  title?: string;
  id?: string;
  titleId?: string;
  className?: string;
  onHash?: (hash: Hash | null) => void;
  onConfirmed?: () => void;
}) {
  const wallet = useWallet(), generation = useRef(0);
  const { info, infoError, revision, refresh } = musegod;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState(""), [slippage, setSlippage] = useState(100);
  const [quote, setQuote] = useState<MusegodQuote | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [progress, setProgress] = useState("");
  const [hash, setHash] = useState<Hash | null>(null), [confirmed, setConfirmed] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null), [balanceError, setBalanceError] = useState("");
  const [clock, setClock] = useState(quoteNow);
  const latestOnHash = useRef(onHash);
  latestOnHash.current = onHash;
  useEffect(() => { latestOnHash.current?.(hash); }, [hash]);

  useEffect(() => {
    setClock(quoteNow(quote ?? undefined));
    const timer = setInterval(() => setClock(quoteNow(quote ?? undefined)), 1000);
    return () => clearInterval(timer);
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
        refresh();
        onConfirmed?.();
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

  const explorer = config ? explorerFor(config) : "https://robinhoodchain.blockscout.com";
  const inputSymbol = side === "buy" ? "ETH" : MUSEGOD.symbol;
  const outputSymbol = side === "buy" ? MUSEGOD.symbol : "ETH";
  const blockReason = info?.tradeBlockReason || config?.blockReason ||
    (!info ? infoError ? "Token verification is unavailable. Refresh to retry." : "Loading token verification…" : null);
  return (
    <section className={`card trade-panel${className ? ` ${className}` : ""}`} id={id} aria-labelledby={titleId}>
      <div className="trade-panel-heading"><h2 id={titleId} className="card-title">{title}</h2><span className="pill">ETH ↔ MUSEGOD</span></div>
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
      <button type="button" className="text-button full" disabled={busy} onClick={refresh}><RefreshCw size={13} /> Refresh token verification and balances</button>
    </section>
  );
}

/** A MUSEGOD-paired coin's page: buy MUSEGOD with ETH before buying the coin. */
export function GetMusegodPanel({ config, onConfirmed }: { config: RuntimeConfig | null; onConfirmed: () => void }) {
  const musegod = useMusegodInfo(config);
  return <MusegodTradePanel config={config} musegod={musegod} title={`Get ${MUSEGOD.symbol} with ETH first`} id="get-musegod" titleId="get-musegod-title"
    className="musegod-acquire" onConfirmed={onConfirmed} />;
}
