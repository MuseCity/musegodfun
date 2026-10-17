import { PriceImpactRow, PriceImpactAcknowledgment } from "./PriceImpact";
import { impactAcknowledged } from "../lib/price-impact";
import { quoteNow } from "../lib/quote-clock";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, CircleAlert, Info, LoaderCircle, RefreshCw, TriangleAlert, Wallet } from "lucide-react";
import SlippageControl from "./SlippageControl";
import { formatUnits, type Hash } from "viem";
import { api } from "../lib/api";
import type { AutoQuoteRequestOptions } from "../lib/auto-quote";
import { explorerFor, shortAddress, type RuntimeConfig } from "../lib/config";
import { MUSEGOD, assertMusegodQuote, musegodNetwork, type MusegodInfo, type MusegodQuote } from "../lib/musegod";
import { errorMessage, parseAmount } from "../lib/validation";
import { maxTradeAmount } from "../lib/trade-amount";
import { useAutoQuote } from "../lib/use-auto-quote";
import { transactionClient, useWallet } from "../lib/wallet";

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

/** The ETH ↔ MUSEGOD trade panel of the MUSEGOD page. */
export default function MusegodTradePanel({ config, musegod, onHash }: {
  config: RuntimeConfig | null;
  musegod: MusegodState;
  onHash?: (hash: Hash | null) => void;
}) {
  const wallet = useWallet(), generation = useRef(0);
  const { info, infoError, revision, refresh } = musegod;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState(""), [slippage, setSlippage] = useState(100);
  const [quote, setQuote] = useState<MusegodQuote | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [progress, setProgress] = useState("");
  const [hash, setHash] = useState<Hash | null>(null), [confirmed, setConfirmed] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null), [balanceError, setBalanceError] = useState("");
  const [quoteError, setQuoteError] = useState(""), [maxLoading, setMaxLoading] = useState(false);
  const [clock, setClock] = useState(quoteNow);
  const [acknowledged, setAcknowledged] = useState<MusegodQuote | null>(null);
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
    setQuoteError("");
    setProgress("");
    setHash(null);
    setConfirmed(false);
    return () => { generation.current++; };
  }, [amount, side, slippage, wallet.account, wallet.chainId, config?.chainId, config?.mode, config?.deploymentChainId]);
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

  const validAmount = (() => { try { return parseAmount(amount, 18) > 0n; } catch { return false; } })();
  const automatic = useAutoQuote<MusegodQuote>({
    key: JSON.stringify([amount, side, slippage, wallet.account, wallet.chainId, config?.chainId, config?.mode, config?.deploymentChainId]),
    lifi: false, valid: validAmount, pool: !!config && musegodNetwork(config) && info !== null,
    busy, completed: !!hash || confirmed, connected: !!wallet.account,
  }, {
    request: getQuote, remaining: next => next.expiresAt - quoteNow(next),
    result: next => { setQuoteError(""); setQuote(next); }, error: failure => setQuoteError(errorMessage(failure)),
  });
  async function getQuote(options: AutoQuoteRequestOptions) {
    if (!config) throw new Error("MUSEGOD quoting requires the active Robinhood Chain network.");
    setQuoteError(""); setQuote(null);
    const next = await api<MusegodQuote>("/musegod/quote", { side, amount, slippageBps: slippage }, options);
    assertMusegodQuote(next, config);
    if (next.side !== side || BigInt(next.amountIn) !== parseAmount(amount, 18) || next.slippageBps !== slippage)
      throw new Error("The quote does not match your trade. Use Refresh quote to try again.");
    return next;
  }
  function refreshQuote() {
    setError(""); setQuoteError(""); setHash(null); setConfirmed(false);
    automatic.refresh();
  }
  function chooseSide(next: "buy" | "sell") {
    if (next !== side) setAmount("");
    setSide(next);
  }
  async function fillMax() {
    if (balance === null || !wallet.account || !config || busy || maxLoading) return;
    const request = generation.current, started = wallet.connection();
    setMaxLoading(true);
    try {
      const client = transactionClient(config.chainId, config);
      const fees = side === "buy" ? await client.estimateFeesPerGas().catch(async () => ({ gasPrice: await client.getGasPrice() })) : undefined;
      const value = maxTradeAmount(balance, side === "buy", fees), current = wallet.connection();
      if (request !== generation.current || current.account !== started.account || current.chainId !== started.chainId) return;
      if (value === null) { setError("Not enough ETH for network fees. Keep the gas reserve in your wallet."); return; }
      setError(""); setAmount(formatUnits(value, 18));
    } catch (failure) { if (request === generation.current) setError(errorMessage(failure)); }
    finally { setMaxLoading(false); }
  }
  async function execute() {
    if (!quote || !config || !info?.tradeEnabled || !impactAcknowledged(quote, acknowledged)) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setQuoteError("");
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
    <section className="card trade-panel" id="trade" aria-labelledby="musegod-trade-title">
      <div className="trade-panel-heading"><h2 id="musegod-trade-title" className="card-title">Trade {MUSEGOD.symbol}</h2><span className="pill">ETH ↔ MUSEGOD</span></div>
      <div className="trade-tabs" role="group" aria-label="Trade side">
        <button type="button" aria-pressed={side === "buy"} className={side === "buy" ? "active" : ""} disabled={busy} onClick={() => chooseSide("buy")}>Buy</button>
        <button type="button" aria-pressed={side === "sell"} className={side === "sell" ? "active sell" : ""} disabled={busy} onClick={() => chooseSide("sell")}>Sell</button>
      </div>
      <div className="musegod-verification" role="group" aria-label="Token verification" tabIndex={blockReason || infoError ? 0 : undefined}>
        <div className={blockReason ? "notice warning" : undefined} role="status">{blockReason && <><TriangleAlert size={17} aria-hidden="true" /><span>{blockReason}</span></>}</div>
        <div className={infoError ? "notice error" : undefined} role={infoError ? "alert" : undefined}>{infoError && <><CircleAlert size={17} aria-hidden="true" /><span>{infoError}</span></>}</div>
      </div>
      <label className="trade-box pay">
        <span className="trade-box-head"><span>You pay <b>{inputSymbol}</b></span>
          <span className="balance">Balance: <b className="musegod-amount" title={exactAmount(balance)}>{amountText(balance)} {inputSymbol}</b></span></span>
        <span className="trade-amount-field">
          <input aria-label="Trade input amount" inputMode="decimal" value={amount} disabled={busy} placeholder="0.00" onChange={(event) => setAmount(event.target.value)} />
          {wallet.account && balance !== null && <button type="button" className="trade-max" disabled={busy || maxLoading}
            onClick={() => void fillMax()}>{maxLoading ? "…" : "Max"}</button>}
        </span>
      </label>
      {side === "sell" && <div className="quick-amounts">
        {[25, 50, 75].map((percent) => <button type="button" key={percent} disabled={busy || balance === null}
          onClick={() => balance !== null && setAmount(formatUnits(balance * BigInt(percent) / 100n, 18))}>{percent}%</button>)}
      </div>}
      <div className="trade-arrow" aria-hidden="true"><ArrowDown size={16} /></div>
      <div className="trade-box receive"><span className="trade-box-head"><span>You receive (estimated) <b>{outputSymbol}</b></span></span>
        <strong className="musegod-amount" title={exactAmount(quote?.amountOut ?? null)}>{automatic.pending ? <><LoaderCircle className="spin" size={16} /> Updating quote…</> : amountText(quote?.amountOut ?? null)}</strong></div>
      <SlippageControl value={slippage} disabled={busy} onChange={setSlippage} />
      {quote && <dl className="rows boxed quote-summary">
        <PriceImpactRow quote={quote} />
        <div><dt>Minimum received</dt><dd className="musegod-amount" title={exactAmount(quote.minAmountOut)}>{amountText(quote.minAmountOut)} {outputSymbol}</dd></div>
        <div><dt>Quote expires in</dt><dd>{Math.max(0, Math.ceil((quote.expiresAt - clock) / 1000))} seconds</dd></div>
      </dl>}
      <PriceImpactAcknowledgment quote={quote} checked={acknowledged === quote} onChange={checked => setAcknowledged(checked ? quote : null)} disabled={busy} />
      {automatic.manual && validAmount && <button type="button" className="text-button quote-refresh"
        disabled={busy || automatic.pending || !config || !musegodNetwork(config) || info === null} onClick={refreshQuote}><RefreshCw size={13} /> Refresh quote</button>}
      {wallet.account ? <button type="button" className="primary large full"
        disabled={!impactAcknowledged(quote, acknowledged) || busy || maxLoading || automatic.pending || !quote || clock >= quote.expiresAt || !config?.writesEnabled || !info?.tradeEnabled || wallet.chainId !== config?.chainId}
        onClick={() => void execute()}>Confirm {side === "buy" ? "Buy" : "Sell"} <ArrowUpRight size={16} /></button>
        : <button type="button" className="primary large full" disabled={wallet.connecting} onClick={() => void wallet.connect()}><Wallet size={16} /> Connect wallet to trade</button>}
      {balanceError && <div className="notice error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>Could not load balance: {balanceError}</span></div>}
      {error && <div className="notice error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span></div>}
      {quoteError && <div className="notice error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{quoteError}</span></div>}
      {progress && <div className="notice" role="status"><Info size={17} aria-hidden="true" /><span>{progress}</span></div>}
      {hash && <div className="musegod-transaction" role="status">{confirmed ? "Confirmed" : "Submitted · Check wallet transaction history"}{" "}
        {explorer ? <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{shortAddress(hash)} ↗</a> : <code>{shortAddress(hash)}</code>}
      </div>}
      <p className="trade-note">Keep some ETH for network fees. ETH is wrapped and unwrapped in the same transaction. Selling may first require approval for the exact MUSEGOD amount. Each step needs your wallet confirmation.</p>
      <button type="button" className="text-button full" disabled={busy} onClick={refresh}><RefreshCw size={13} /> Refresh token verification and balances</button>
    </section>
  );
}
