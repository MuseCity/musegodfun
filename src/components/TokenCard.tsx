import { useState } from "react";
import { Sparkles } from "lucide-react";
import { shortAddress, type Stock, type TokenRecord } from "../lib/config";
import type { CardMarketState } from "../lib/token-card-market";
import { summaryHasValues } from "../lib/market";
import assetLogos from "../lib/asset-logos.json";
import { tokenPath } from "../lib/network";
import { changeClass as changeKind, percentChange as percent, relativeTime, tokenImageSrc, usdCompact as usd } from "../lib/format";
import { nftBadge } from "../lib/nft-treasury";

export type TokenCardToken = Pick<TokenRecord, "address" | "name" | "symbol" | "image" | "creator" | "mode" | "deploymentChainId" | "nft" | "nftVerification"> & {
  kind: "launch" | "musegod";
  quote: Stock;
  createdAt?: number;
  tradingFeeBps?: number;
};

function QuoteIcon({ ticker }: { ticker: string }) {
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const logo = (assetLogos as Partial<Record<string, { path: string; background?: string }>>)[ticker];
  return <span className="token-card-quote-icon" aria-hidden="true" style={{ background: logo?.background }}>
    {logo && failedPath !== logo.path
      ? <img src={logo.path} alt="" loading="lazy" decoding="async" onError={() => setFailedPath(logo.path)} />
      : ticker.slice(0, 2)}
  </span>;
}

/** An NFT coin's badge: plain text, so a card that is one link never nests an action. The unverified-collection warning is safety copy
 * and keeps the full-size warning style; `withContract` adds the collection's short address where space allows. */
export function NftBadge({ token, withContract = false }: { token: Pick<TokenRecord, "nft" | "nftVerification">; withContract?: boolean }) {
  const label = nftBadge(token, { withContract });
  return label ? <span className={`badge nft-badge${label.includes("unverified") ? " nft-warning" : ""}`}>{label}</span> : null;
}

/** "Fetched" is reserved for a snapshot that holds a value. A request that returned none, or no snapshot at all, shows when it
 * was checked, so a recent request time is never read as recent market data. */
export function CardMarketStatus({ market }: { market: CardMarketState }) {
  const stats = market.data?.status === "unavailable" ? null : market.data;
  const source = stats?.source === "Bankr" ? "Bankr / Pools" : stats?.source;
  const stale = stats?.status === "stale", values = summaryHasValues(stats);
  const clock = (iso: string | undefined) => {
    if (!iso || !Number.isFinite(Date.parse(iso))) return null;
    const at = new Date(iso);
    return <time dateTime={iso} title={at.toISOString()}>{at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</time>;
  };
  const fetched = stats && clock(stats.fetchedAt), checked = !stats && !market.loading ? clock(market.checkedAt) : null;
  return <div className={`token-card-market-state${stale ? " stale" : ""}`} role="status"
    title={stats?.warning || market.error || undefined}>
    {stats ? <>
      {source && <span>{source}</span>}
      {!values && <span>No market price yet</span>}
      <span>{values ? stale ? "Previous snapshot" : "Fetched" : stale ? "Previous check" : "Checked"}{fetched && <> · {fetched}</>}</span>
      {market.loading && <span>Updating…</span>}
    </> : <>
      <span>{market.loading ? "Loading market data…" : market.error || "Market data unavailable"}</span>
      {checked && <span>Checked · {checked}</span>}
    </>}
  </div>;
}

export default function TokenCard({ token, market, onNavigate }: {
  token: TokenCardToken;
  market: CardMarketState;
  onNavigate: (path: string) => void;
}) {
  const image = tokenImageSrc(token);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const stats = market.data?.status === "unavailable" ? null : market.data;
  const change = stats?.periods.h24?.change;
  const changeClass = changeKind(change);
  const href = tokenPath(token);
  const details = token.kind === "musegod" ? "Featured · SushiSwap v3 · 1% pool"
    : ["Doppler · Uniswap v4", token.tradingFeeBps !== undefined ? `${token.tradingFeeBps / 100}% fee` : null,
      token.createdAt !== undefined ? relativeTime(token.createdAt) : null].filter(Boolean).join(" · ");
  return <a href={href} className={`token-card${token.kind === "musegod" ? " featured-token" : ""}`}
    aria-label={`${token.name} token details`}
    onClick={(event) => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        onNavigate(href);
      }
    }}>
    <div className="token-card-top">
      <div className="token-card-image">
        {image && failedImage !== image
          ? <img key={image} src={image} alt={token.name} loading="lazy" decoding="async" referrerPolicy="no-referrer"
              onError={() => setFailedImage(image)} />
          : <span className="token-card-image-fallback" aria-hidden="true">{token.name.slice(0, 1).toUpperCase() || "?"}</span>}
      </div>
      <div className="token-card-identity">
        <div className="token-card-name">
          <h3 title={token.name}>{token.name}</h3>
          {token.kind === "musegod" && <span className="featured-label"><Sparkles size={11} /> Featured</span>}
        </div>
        <NftBadge token={token} />
        <span className="token-card-pair">
          <span className="token-card-symbol" title={`$${token.symbol}`}>${token.symbol}</span>
          <span aria-hidden="true">·</span>
          <QuoteIcon ticker={token.quote.ticker} />{token.quote.ticker} pair
        </span>
        <span className="token-card-venue" title={token.address}>{details}</span>
      </div>
    </div>
    <dl className="token-card-metrics">
      <div><dt>Market cap</dt><dd>{usd(stats?.marketCapUsd)}</dd></div>
      <div><dt>24h volume</dt><dd>{usd(stats?.periods.h24?.volume)}</dd></div>
      <div><dt>24h change</dt><dd className={changeClass}>{percent(change)}</dd></div>
    </dl>
    <CardMarketStatus market={market} />
    <div className="token-card-footer">
      <div><span>Creator</span><span title={token.creator ?? undefined}>{token.creator ? shortAddress(token.creator) : "—"}</span></div>
      <span className="token-card-network">{token.mode === "fork" ? "Fork test" : token.mode === "robinhood" ? "Robinhood Chain" : "Base"}</span>
    </div>
  </a>;
}
