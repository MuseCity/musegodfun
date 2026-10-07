import { useState } from "react";
import { Sparkles } from "lucide-react";
import { shortAddress, type Stock, type TokenRecord } from "../lib/config";
import { MUSEGOD } from "../lib/musegod";
import { safeImage } from "../lib/validation";
import type { CardMarketState } from "../lib/token-card-market";
import assetLogos from "../lib/asset-logos.json";
import { tokenPath } from "../lib/network";

export type TokenCardToken = Pick<TokenRecord, "address" | "name" | "symbol" | "image" | "creator" | "mode" | "deploymentChainId"> & {
  kind: "launch" | "musegod";
  quote: Stock;
};

const usd = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—"
  : `$${value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })}`;
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value)
  ? "—"
  : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

function QuoteIcon({ ticker }: { ticker: string }) {
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const logo = (assetLogos as Partial<Record<string, { path: string; background?: string }>>)[ticker];
  return <span className="token-card-quote-icon" aria-hidden="true" style={{ background: logo?.background }}>
    {logo && failedPath !== logo.path
      ? <img src={logo.path} alt="" loading="lazy" decoding="async" onError={() => setFailedPath(logo.path)} />
      : ticker.slice(0, 2)}
  </span>;
}

export default function TokenCard({ token, market, onNavigate }: {
  token: TokenCardToken;
  market: CardMarketState;
  onNavigate: (path: string) => void;
}) {
  const image = token.kind === "musegod" ? MUSEGOD.image : safeImage(token.image);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const stats = market.data?.status === "unavailable" ? null : market.data;
  const change = stats?.periods.h24?.change;
  const changeClass = change != null && Number.isFinite(change) && change !== 0
    ? change > 0 ? "positive" : "negative"
    : "neutral";
  const source = stats?.source === "Bankr" ? "Bankr / Pools" : stats?.source;
  const at = stats && Number.isFinite(Date.parse(stats.fetchedAt)) ? new Date(stats.fetchedAt) : null;
  const snapshotLabel = stats?.status === "stale" ? "Previous snapshot" : "Updated";
  const href = tokenPath(token);
  return <a href={href} className={`token-card${token.kind === "musegod" ? " featured-token" : ""}`}
    aria-label={`${token.name} token details`}
    onClick={(event) => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        onNavigate(href);
      }
    }}>
    <div className="token-card-image">
      {image && failedImage !== image
        ? <img key={image} src={image} alt={token.name} loading="lazy" decoding="async" referrerPolicy="no-referrer"
            onError={() => setFailedImage(image)} />
        : <span className="token-card-image-fallback" aria-hidden="true">{token.name.slice(0, 1) || "?"}</span>}
    </div>
    <div className="token-card-name">
      <h3 title={token.name}>{token.name}</h3>
      {token.kind === "musegod" && <span className="featured-label"><Sparkles size={11} /> Featured</span>}
    </div>
    <div className="token-card-identity">
      <span className="token-card-symbol" title={`$${token.symbol}`}>${token.symbol}</span>
      <span className="token-card-pair"><QuoteIcon ticker={token.quote.ticker} />{token.quote.ticker} pair</span>
    </div>
    <span className="token-card-venue">{token.kind === "musegod" ? "SushiSwap v3" : "Meme · Doppler · Uniswap v4"}</span>
    <code className="token-card-address" title={token.address}>{shortAddress(token.address)}</code>
    <dl className="token-card-metrics">
      <div><dt>Market cap</dt><dd>{usd(stats?.marketCapUsd)}</dd></div>
      <div><dt>24h volume</dt><dd>{usd(stats?.periods.h24?.volume)}</dd></div>
      <div><dt>24h change</dt><dd className={changeClass}>{percent(change)}</dd></div>
    </dl>
    <div className={`token-card-market-state${stats?.status === "stale" ? " stale" : ""}`} role="status"
      title={stats?.warning || market.error || undefined}>
      {stats ? <>
        {source && <span>{source}</span>}
        <span>{snapshotLabel}{at && <> · <time dateTime={stats.fetchedAt} title={at.toISOString()}>{at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</time></>}</span>
        {market.loading && <span>Updating…</span>}
      </> : <span>{market.loading ? "Loading market data…" : market.error || "Market data unavailable"}</span>}
    </div>
    <div className="token-card-footer">
      <div><span>Creator</span><span title={token.creator ?? undefined}>{token.creator ? shortAddress(token.creator) : "—"}</span></div>
      <span className="token-card-network">{token.mode === "fork" ? "Fork test" : token.mode === "robinhood" ? "Robinhood Chain" : "Base"}</span>
    </div>
  </a>;
}
