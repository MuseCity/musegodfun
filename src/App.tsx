import { dopplerUrl } from "./lib/doppler";
import TransactionHistory from "./components/TransactionHistory";
import { updateTransaction } from "./lib/transactions";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Coins,
  Compass,
  Copy,
  ExternalLink,
  Flame,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Ticket,
  Wallet,
  X,
} from "lucide-react";
import {
  encodeFunctionData,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import type { V4PoolKey } from "@whetstone-research/doppler-sdk/evm";
import { claimFeesAbi } from "./lib/protocol";
import {
  FEE_POLICY,
  FEE_SHARES,
  MUSEGOD_BUYBACK,
  allocateFeeIncome,
  feePolicyFor,
} from "./lib/fee-policy";
import {
  assetsFor,
  contractsFor,
  deploymentChain,
  explorerFor,
  networkName,
  sameAddress,
  listedTokens,
  shortAddress,
  poolCurrency,
  quoteAsset,
  shareEquivalent,
  type RuntimeConfig,
  type Stock,
  type StockStatus,
  type TokenRecord,
} from "./lib/config";
import {
  errorMessage,
  launchSchema,
  minimumOutput,
  restoreDraft,
  safeImage,
  safeSocialLink,
  type LaunchInput,
} from "./lib/validation";
import { api } from "./lib/api";
import {
  OPENING_CAP_USD,
  OPENING_POLICY,
  assertOpeningValuation,
} from "./lib/opening-valuation";
import { TOKEN_IMAGE_ACCEPT } from "./lib/token-image";
import { prepareTokenImage } from "./lib/image-upload";
import { useWallet, type Quote } from "./lib/wallet";
import type { LaunchPlan } from "../server/store";

import TokenMarket from "./components/TokenMarket";
import MusegodPage from "./components/MusegodPage";
import { MUSEGOD } from "./lib/musegod";
import BuybackPage from "./components/BuybackPage";
import FeeBreakdown from "./components/FeeBreakdown";
import { ASSET_CATEGORIES, assetCategory, type AssetCategory } from "./lib/asset-categories";
import assetLogos from "./lib/asset-logos.json";
import { buildIdentity } from "./lib/build-info";
import TokenCard from "./components/TokenCard";
import { useTokenCardMarkets } from "./lib/token-card-market";

function useResource<T>(path: string, version = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(null);
    setError("");
    api<T>(path)
      .then((x) => {
        if (active) setData(x);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, version]);
  return { data, error, loading };
}
function navigate(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}
function Link({
  href,
  children,
  ...rest
}: {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}
function Notice({
  children,
  kind = "info",
}: {
  children: ReactNode;
  kind?: "info" | "error" | "success";
}) {
  return (
    <div
      className={`notice ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {kind === "success" ? (
        <CheckCircle2 size={17} />
      ) : (
        <CircleHelp size={17} />
      )}
      <span>{children}</span>
    </div>
  );
}
function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={20} />
      Loading on-chain data…
    </div>
  );
}
function FieldError({
  name,
  invalidField,
  error,
}: {
  name: string;
  invalidField: string;
  error: string;
}) {
  return invalidField === name ? (
    <span className="field-error" id={`launch-error-${name}`} role="alert">
      {error}
    </span>
  ) : null;
}
function StockIcon({
  stock,
  small = false,
}: {
  stock: Pick<Stock, "ticker">;
  small?: boolean;
}) {
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const logo = (assetLogos as Partial<Record<string, { path: string; background?: string }>>)[stock.ticker];
  const path = logo?.path;
  const showLogo = path && failedPath !== path;
  return (
    <span
      className={`stock-icon ${small ? "small" : ""} ${showLogo ? "has-logo" : ""}`}
      style={showLogo && logo?.background ? { background: logo.background } : undefined}
      aria-hidden="true"
    >
      {showLogo ? (
        <img src={path} alt="" loading="lazy" decoding="async"
          onError={() => setFailedPath(path)} />
      ) : stock.ticker.slice(0, 2)}
    </span>
  );
}
function TokenIcon({ name, image }: { name: string; image?: string }) {
  return (
    <span className="token-icon">
      {image && safeImage(image) ? (
        <img
          key={image}
          src={safeImage(image)}
          alt=""
          referrerPolicy="no-referrer"
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
        />
      ) : null}
      <span>{name.slice(0, 1) || "?"}</span>
    </span>
  );
}
function NumberText({
  value,
  decimals = 18,
}: {
  value: bigint | string;
  decimals?: number;
}) {
  const text = formatUnits(BigInt(value), decimals),
    n = Number(text);
  return (
    <span title={text}>
      {n === 0
        ? "0"
        : n < 10 ** -Math.min(decimals, 8)
          ? `< ${formatUnits(1n, Math.min(decimals, 8))}`
          : new Intl.NumberFormat("en-US", {
              maximumFractionDigits: Math.min(decimals, 8),
            }).format(n)}
    </span>
  );
}
function StockShares({
  value,
  stock,
  status,
}: {
  value: bigint | string;
  stock: Pick<Stock, "ticker" | "decimals" | "standard">;
  status: StockStatus | undefined;
}) {
  if (stock.standard !== "B20") return null;
  if (!status?.verified || !status.multiplierWad)
    return <span className="share-equivalent">Share equivalent unavailable</span>;
  return (
    <span className="share-equivalent">
      Approximately{" "}
      <NumberText
        value={shareEquivalent(BigInt(value), BigInt(status.multiplierWad))}
        decimals={stock.decimals}
      />{" "}
      {stock.ticker} shares
    </span>
  );
}
function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={14} />
    </a>
  );
}
function SocialLinks({
  token,
}: {
  token: Pick<LaunchInput, "website" | "twitter" | "telegram">;
}) {
  const links = [
    { label: "Website", url: safeSocialLink(token.website ?? "") },
    { label: "X", url: safeSocialLink(token.twitter ?? "", "x") },
    {
      label: "Telegram",
      url: safeSocialLink(token.telegram ?? "", "telegram"),
    },
  ].filter((link) => link.url);
  if (!links.length) return null;
  return (
    <div className="social-links">
      {links.map((link) => (
        <External key={link.label} href={link.url}>
          {link.label}
        </External>
      ))}
    </div>
  );
}
function pendingLaunchKey(config: RuntimeConfig) {
  return `musegod.pending.launch.${config.chainId}${config.mode === "fork" ? `.${deploymentChain(config)}` : ""}`;
}
function TxLink({ hash, config }: { hash: string; config: RuntimeConfig }) {
  const explorer = explorerFor(config);
  return explorer ? (
    <External href={`${explorer}/tx/${hash}`}>View transaction</External>
  ) : (
    <code className="wrap">Local transaction: {hash}</code>
  );
}
const feePercent = (basisPoints: number) => `${basisPoints / 100}%`;
const openingCapUsdLabel = `$${OPENING_CAP_USD.toLocaleString("en-US")}`;
function Curve({ ticker, cap, fixedUsd = false }: { ticker: string; cap?: string; fixedUsd?: boolean }) {
  return (
    <div className="curve">
      <div className="curve-label">
        <span>Supply curve</span>
        <span>Priced in {ticker}</span>
      </div>
      <svg
        viewBox="0 0 340 132"
        role="img"
        aria-label="Illustrative launch curve showing price increasing with sold supply; not historical market data"
      >
        <defs>
          <linearGradient id="curve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#bcf26b" stopOpacity=".65" />
            <stop offset="100%" stopColor="#bcf26b" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M0 30H340 M0 65H340 M0 100H340"
          stroke="#e4e7df"
          strokeDasharray="3 5"
        />
        <path
          d="M0 117C100 117 200 113 253 95C300 80 309 47 330 10L330 132H0Z"
          fill="url(#curve-fill)"
        />
        <path
          d="M0 117C100 117 200 113 253 95C300 80 309 47 330 10"
          fill="none"
          stroke="#6c981c"
          strokeWidth="2.5"
        />
        <circle cx="1" cy="117" r="3" fill="#6c981c" />
      </svg>
      <div className="curve-label">
        <span>
          {fixedUsd ? <>Opens at <b>{openingCapUsdLabel}</b> market cap</> : <>Opening valuation {cap || "—"} {ticker}</>}
        </span>
        <span>Supply →</span>
      </div>
      <small>Illustrative curve · Not historical prices or a return forecast</small>
    </div>
  );
}

export function App() {
  const helpDialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(location.pathname),
    [version, setVersion] = useState(0),
    [showHelp, setHelp] = useState(false);
  useEffect(() => {
    const fn = () => setPath(location.pathname);
    window.addEventListener("popstate", fn);
    return () => window.removeEventListener("popstate", fn);
  }, []);
  useEffect(() => {
    if (showHelp) helpDialog.current?.showModal();
  }, [showHelp]);
  const config = useResource<RuntimeConfig>("/config", version),
    stocks = useResource<StockStatus[]>("/stocks", version),
    tokens = useResource<TokenRecord[]>("/tokens", version),
    wallet = useWallet();
  const current =
    path === "/create"
      ? "create"
      : path === "/rewards"
        ? "rewards"
        : path === "/buyback"
          ? "buyback"
          : "explore";
  const tokenAddress = path.startsWith("/token/") ? path.split("/")[2] : null;
  const assets = assetsFor(config.data ?? undefined);
  const chainName = config.data ? networkName(config.data) : "Loading network…";
  const nav = [
    { href: "/", id: "explore", icon: Compass, label: "Explore" },
    { href: "/create", id: "create", icon: Plus, label: "Launch token" },
    { href: "/rewards", id: "rewards", icon: Coins, label: "My rewards" },
    { href: "/buyback", id: "buyback", icon: Flame, label: "Buyback and burn" },
  ];
  const title =
    current === "create"
      ? "Launch token"
      : current === "rewards"
        ? "Creator rewards"
        : current === "buyback"
          ? "MUSEGOD buyback and burn"
          : tokenAddress
            ? "Token details"
            : "Discover what’s next";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <img src="/favicon.svg" alt="" />
          musegod<span>.fun</span>
        </Link>
        <div className="side-label">THE NEXT BIG LITTLE THING</div>
        <nav>
          {nav.map((n) => (
            <Link
              href={n.href}
              key={n.id}
              className={`nav-link ${current === n.id ? "active" : ""}`}
            >
              <n.icon size={19} />
              {n.label}
              {n.id === "create" && <span className="nav-plus">+</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="side-note">
            <Sparkles size={19} />
            <strong>Turn inspiration into a token.</strong>
            <span>
              Paired with tokenized assets
              <br />Built on {chainName}
            </span>
          </div>
          <button className="help-link" onClick={() => setHelp(true)}>
            <CircleHelp size={17} />
            How it works
            <ArrowUpRight size={14} />
          </button>
          <div className="network">
            <span className="chain-mark" />
            {chainName}
            <span className="network-tag">
              {config.data?.mode === "fork" ? "LOCAL FORK" : "MAINNET"}
            </span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>musegod.fun</span>
            <ChevronRight size={14} />
            {title}
          </div>
          <div className="topbar-actions">
            {(!config.data?.writesEnabled || config.data?.mode === "fork") && (
              <span className="preview-badge">
                <span className="dot" />
                {config.data?.writesEnabled ? "Local fork" : "Mainnet read-only"}
              </span>
            )}
            <button
              className="wallet-button"
              disabled={wallet.connecting}
              onClick={() => void wallet.connect()}
            >
              <Wallet size={16} />
              {wallet.connecting
                ? "Connecting…"
                : wallet.account
                  ? shortAddress(wallet.account)
                  : "Connect wallet"}
            </button>
          </div>
        </header>
        <div className="mobile-nav">
          {nav.map((n) => (
            <Link
              href={n.href}
              key={n.id}
              className={current === n.id ? "selected" : ""}
            >
              <n.icon size={17} />
              {n.label}
            </Link>
          ))}
        </div>
        <main>
          {wallet.error && <Notice kind="error">{wallet.error}</Notice>}
          {config.error && <Notice kind="error">{config.error}</Notice>}
          {config.data?.mode === "fork" && (
            <Notice>
              Connected to {chainName}. Funds and transactions exist only in this local test environment.
            </Notice>
          )}
          {wallet.account &&
            config.data &&
            wallet.chainId !== config.data.chainId && (
              <Notice kind="error">
                Your wallet network differs from the platform. Switch before trading to{" "}
                {chainName} ({config.data.chainId})
                .
                <button
                  onClick={() => void wallet.switchChain(config.data!.chainId)}
                >
                  Switch network
                </button>
              </Notice>
            )}
          <TransactionHistory config={config.data} />
          {!/^\/(?:create|rewards|buyback)?$/.test(path) &&
          !/^\/token\/0x[0-9a-fA-F]{40}$/.test(path) ? (
            <section className="panel">
              <h1>Page not found</h1>
              <Link href="/">Back to home</Link>
            </section>
          ) : current === "create" ? (
            <CreatePage
              stocks={stocks.data}
              stockError={stocks.error}
              config={config.data}
              refresh={() => setVersion((v) => v + 1)}
            />
          ) : current === "rewards" ? (
            <Rewards tokens={tokens.data ?? []} config={config.data} />
          ) : current === "buyback" ? (
            <BuybackPage config={config.data} />
          ) : tokenAddress && sameAddress(tokenAddress, MUSEGOD.token) ? (
            <MusegodPage config={config.data} navigate={navigate} />
          ) : tokenAddress ? (
            <TokenPage
              key={tokenAddress}
              address={tokenAddress}
              config={config.data}
            />
          ) : (
            <Explore
              tokens={tokens.data}
              tokenError={tokens.error}
              stocks={stocks.data}
              stockError={stocks.error}
              loading={tokens.loading}
              config={config.data}
              refreshVersion={version}
              refresh={() => setVersion((v) => v + 1)}
            />
          )}
        </main>
        <footer>
          <span>
            Launches: <b>Doppler</b> + <b>Uniswap v4</b>
          </span>
          <span>Your meme token does not represent ownership of the underlying stock.</span>
          <External href="https://docs.doppler.lol/">Protocol docs</External>
          <div className="build-provenance">
            {buildIdentity.source === "github-actions" ? <>
              <External href={`${buildIdentity.repository}/commit/${buildIdentity.commit}`}>
                Source {buildIdentity.commit.slice(0, 7)}
              </External>
              <span aria-hidden="true">·</span>
              <External href={buildIdentity.releaseUrl!}>Verify build</External>
            </> : <span title={`Source base: ${buildIdentity.commit}`}>
              Local build{buildIdentity.dirty ? " (dirty)" : ""} · {buildIdentity.commit.slice(0, 7)}
            </span>}
          </div>
        </footer>
      </div>
      {showHelp && (
        <dialog
          ref={helpDialog}
          className="modal"
          aria-label="How it works"
          onCancel={() => setHelp(false)}
          onClose={() => setHelp(false)}
        >
          <button
            className="close-button"
            aria-label="Close help"
            onClick={() => setHelp(false)}
          >
            <X />
          </button>
          <span className="eyebrow">HOW IT WORKS</span>
          <h2>One meme. One stock pair.</h2>
          <p>
            Choose a supported asset on {chainName} as the quote asset. The new meme’s 1 billion tokens enter a Doppler multicurve pool, and trades settle in the selected quote asset.
          </p>
          <div className="help-steps">
            <p>
              <b>01 Choose a quote asset</b>
              <span>{assets.slice(0, 3).map((asset) => asset.symbol).join(", ")}.</span>
            </p>
            <p>
              <b>02 Create a fixed-supply meme</b>
              <span>Liquidity is locked in Uniswap v4, with no graduation threshold.</span>
            </p>
            <p>
              <b>03 Claim your trading fees</b>
              <span>New pools first deduct Doppler’s {feePercent(FEE_SHARES.protocol)} protocol share. Of the remaining net fees, the creator receives {feePercent(FEE_SHARES.creatorNet)}; the platform receives {feePercent(FEE_SHARES.platformNet)}. Platform income is then allocated {feePercent(FEE_SHARES.platformBuyback)} to buybacks and {feePercent(FEE_SHARES.platformOperations)} to operations.</span>
            </p>
          </div>
          <Notice>
            Paired assets follow their issuer’s transfer, redemption, and regional rules. The meme token itself does not represent company stock.
          </Notice>
          <button className="primary" onClick={() => setHelp(false)}>
            Got it
            <Check size={16} />
          </button>
        </dialog>
      )}
    </div>
  );
}

// Display entries are separate from verified launch records and their fee policy.
export type ExploreToken = Pick<TokenRecord, "address" | "name" | "symbol" | "description" | "image" | "createdAt" | "mode" | "creator"> & {
  kind: "launch" | "musegod";
  quote: Stock;
};
export function exploreTokens(
  tokens: TokenRecord[], config: RuntimeConfig | null, search: string,
  filter: string, order: "new" | "name",
): ExploreToken[] {
  const featured = deploymentChain(config ?? { mode: "robinhood", deploymentChainId: 4663 }) === 4663;
  const entries: ExploreToken[] = tokens
    .filter((token) => !featured || !sameAddress(token.address, MUSEGOD.token))
    .map((token) => ({
      kind: "launch", address: token.address, name: token.name, symbol: token.symbol,
      description: token.description, image: token.image, createdAt: token.createdAt,
      mode: token.mode, creator: token.creator, quote: quoteAsset(token),
    }));
  if (featured) {
    const quote = assetsFor({ mode: "robinhood" }).find((asset) => sameAddress(asset.address, MUSEGOD.weth))!;
    entries.push({ kind: "musegod", address: MUSEGOD.token, name: MUSEGOD.name,
      symbol: MUSEGOD.symbol, description: MUSEGOD.description, image: MUSEGOD.image,
      createdAt: MUSEGOD.createdAt, mode: config?.mode ?? "robinhood", creator: null, quote });
  }
  const query = search.trim().toLowerCase();
  return entries
    .filter((entry) => (filter === "all" || entry.quote.ticker === filter) &&
      `${entry.name} ${entry.symbol} ${entry.address}`.toLowerCase().includes(query))
    .sort((a, b) => {
      if (!query && filter === "all" && a.kind !== b.kind) return a.kind === "musegod" ? -1 : 1;
      return order === "name" ? a.name.localeCompare(b.name) : b.createdAt - a.createdAt;
    });
}

export function Explore({
  tokens,
  tokenError,
  stocks,
  stockError,
  loading,
  config,
  refreshVersion = 0,
  refresh,
}: {
  tokens: TokenRecord[] | null;
  tokenError: string;
  stocks: StockStatus[] | null;
  stockError: string;
  loading: boolean;
  config: RuntimeConfig | null;
  refreshVersion?: number;
  refresh: () => void;
}) {
  // Resource refreshes temporarily clear their data. Keep the confirmed
  // directory visible, without carrying entries into another deployment.
  const directory = useRef<{ config: RuntimeConfig | null; tokens: TokenRecord[] }>({ config: null, tokens: [] });
  if (config && directory.current.config &&
    (config.mode !== directory.current.config.mode || config.chainId !== directory.current.config.chainId ||
      deploymentChain(config) !== deploymentChain(directory.current.config))) directory.current.tokens = [];
  if (config) directory.current.config = config;
  const displayConfig = config ?? directory.current.config;
  if (tokens !== null) directory.current.tokens = displayConfig
    ? listedTokens(tokens, displayConfig.mode, deploymentChain(displayConfig)) : tokens;
  const assets = assetsFor(displayConfig ?? undefined);
  const chainName = displayConfig ? networkName(displayConfig) : "Loading network…";
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [order, setOrder] = useState("new");
  const filtered = exploreTokens(directory.current.tokens, displayConfig, search, filter, order === "name" ? "name" : "new");
  const markets = useTokenCardMarkets(directory.current.tokens, config, refreshVersion);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MEMES MEET MARKETS</span>
          <h1>
            A small idea,
            <br className="mobile-break" />
            endless possibilities<span className="accent">.</span>
          </h1>
          <p>Launch your meme, paired with an asset you like.</p>
        </div>
        <Link href="/create" className="primary">
          <Plus size={18} />
          Launch token
        </Link>
      </div>
      <div className="market-intro">
        <div className="market-copy">
          <span className="pill">
            <span className="chain-mark" />
            ON {chainName.toUpperCase()}
          </span>
          <h2>
            Your meme,
            <br />
            its own trading pair.
          </h2>
          <p>
            NVDA, TSLA, AAPL…
            <br />
            From an idea to an on-chain community.
          </p>
          <Link href="/create">
            Start with an asset
            <ArrowRight size={18} />
          </Link>
        </div>
        <div className="stock-orbit" aria-label="Illustration of quote asset pairs">
          <div className="orbit-circle" />
          <span className="orbit-center">
            <Ticket size={42} />
            <b>YOUR MEME</b>
          </span>
          {assets.filter((s) => ["NVDA", "AAPL", "TSLA", "MSFT", "AMZN", "GOOGL"].includes(s.ticker)).slice(0, 6).map((s, i) => (
            <div className={`orbit-item orbit-${i}`} key={s.ticker}>
              <StockIcon stock={s} />
              <span>{s.ticker}</span>
            </div>
          ))}
        </div>
        <div className="intro-facts">
          <span>
            <b>1B</b>New launch supply
          </span>
          <span>
            <b>{stocks ? stocks.filter((s) => s.verified).length : "—"}</b>
            Verified paired assets
          </span>
          <span>
            <b>1.05%</b>New launch fee
          </span>
        </div>
      </div>
      <div className="section-heading">
        <h2>
          Explore tokens <span className="count">{filtered.length}</span>
        </h2>
        <button
          className="icon-button"
          title="Refresh data"
          aria-label="Refresh data"
          onClick={refresh}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <div className="filters">
        <div className="search-input">
          <Search size={17} />
          <input
            aria-label="Search tokens"
            placeholder="Search by name, symbol, or contract address"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter by quote asset"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All quote assets</option>
          {ASSET_CATEGORIES.map((category) => {
            const group = assets.filter((asset) => assetCategory(asset) === category.id);
            return group.length ? <optgroup key={category.id} label={category.label}>
              {group.map((asset) => <option key={asset.address} value={asset.ticker}>
                {asset.ticker} · {asset.name}
              </option>)}
            </optgroup> : null;
          })}
        </select>
        <select
          aria-label="Token sort order"
          value={order}
          onChange={(e) => setOrder(e.target.value)}
        >
          <option value="new">Newest launches</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>
      {tokenError && <Notice kind="error">Platform launches could not be loaded: {tokenError}</Notice>}
      {loading && <Loading />}
      {filtered.length ? (
        <div className="token-grid">
          {filtered.map((t) => <TokenCard key={t.address} token={t} onNavigate={navigate}
            market={markets[t.address.toLowerCase()] ?? {
              data: null, loading: !config,
              error: t.mode === "fork" ? "Fork test" : "Market data unavailable",
            }} />)}
        </div>
      ) : !loading && !tokenError ? (
        <div className="empty-state">
          <div className="empty-symbol">
            <Sparkles size={29} />
          </div>
          <h3>
            {search || filter !== "all"
              ? "No matching tokens"
              : "The first story starts with you."}
          </h3>
          <p>
            {search || filter !== "all"
              ? "Try another search or quote asset filter."
              : "No confirmed launches have been registered yet. Choose an asset and create a pair for your idea."}
          </p>
          <Link href="/create" className="secondary">
            Create your meme
            <ArrowUpRight size={16} />
          </Link>
        </div>
      ) : null}
      {stockError && (
        <Notice kind="error">Asset contract verification is unavailable: {stockError}</Notice>
      )}
      <div className="info-strip">
        <LockKeyhole size={18} />
        <span>New launches: Fixed supply · Locked liquidity · Creator rewards</span>
        <span>New launches are listed after on-chain confirmation</span>
      </div>
    </>
  );
}

function CreatePage({
  stocks,
  stockError,
  config,
  refresh,
}: {
  stocks: StockStatus[] | null;
  stockError: string;
  config: RuntimeConfig | null;
  refresh: () => void;
}) {
  const generation = useRef(0);
  const activeSimulation = useRef<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null),
    imageInput = useRef<HTMLInputElement>(null),
    imageUpload = useRef(0),
    reviewDialog = useRef<HTMLDialogElement>(null);
  const wallet = useWallet(),
    [draft, setDraft] = useState<LaunchInput>(() => {
      try {
        return restoreDraft(localStorage.getItem("musegod.launch.draft"), config ?? undefined);
      } catch {
        return restoreDraft(null, config ?? undefined);
      }
    });
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState<AssetCategory>("all"),
    [showAllAssets, setShowAllAssets] = useState(false),
    [draftSaved, setDraftSaved] = useState(false),
    [invalidField, setInvalidField] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [review, setReview] = useState(false),
    [plan, setPlan] = useState<LaunchPlan | null>(null),
    [planExpired, setPlanExpired] = useState(false),
    [busy, setBusy] = useState(false),
    [uploadingImage, setUploadingImage] = useState(false),
    [imageError, setImageError] = useState(""),
    [txHash, setTxHash] = useState<Hex | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const assets = assetsFor(config ?? undefined);
  const stock = assets.find((asset) => sameAddress(asset.address, draft.quoteAddress)) ?? assets[0],
    status = stocks?.find((s) => sameAddress(s.address, stock.address)),
    matching = (
      stocks ??
      assets.map((s) => ({
        ...s,
        verified: false,
        blockNumber: "",
        totalSupply: null,
        multiplierWad: null,
      }))
    ).filter((s) =>
      (category === "all" || assetCategory(s) === category) &&
      `${s.ticker} ${s.symbol} ${s.name} ${s.address}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    );
  const visibleAssets = matching.slice(0, showAllAssets || query.trim() ? matching.length : 12);
  useEffect(() => {
    generation.current++;
    setPlan(null);
    setMessage("");
    return () => {
      generation.current++;
    };
  }, [wallet.revision]);
  useEffect(() => () => { imageUpload.current++; }, []);
  useEffect(() => {
    if (!config || assets.some((asset) => sameAddress(asset.address, draft.quoteAddress))) return;
    generation.current++;
    setDraft((previous) => ({ ...previous, quoteAddress: assets[0].address }));
    setPlan(null);
    setReview(false);
    setInvalidField("");
    setError("");
  }, [config?.chainId, config?.deploymentChainId, draft.quoteAddress]);
  useEffect(() => {
    const dialog = reviewDialog.current;
    if (review && dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [review]);
  useEffect(() => {
    if (!plan?.openingValuation) {
      setPlanExpired(false);
      return;
    }
    const remaining = plan.openingValuation.expiresAt - Date.now();
    setPlanExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setPlanExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [plan]);
  useEffect(() => {
    setDraftSaved(false);
    const timer = setTimeout(() => {
      try {
        localStorage.setItem("musegod.launch.draft", JSON.stringify(draft));
        setDraftSaved(true);
      } catch {
        setDraftSaved(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    if (!config) return;
    try {
      setTxHash(
        localStorage.getItem(
          pendingLaunchKey(config),
        ) as Hex | null,
      );
    } catch {
      /* Storage may be unavailable. */
    }
  }, [config?.chainId, config?.deploymentChainId]);
  function update<K extends keyof LaunchInput>(key: K, value: LaunchInput[K]) {
    if (key === "image") {
      imageUpload.current++;
      setUploadingImage(false);
      setImageError("");
    }
    generation.current++;
    setDraft((d) => ({ ...d, [key]: value }));
    setInvalidField("");
    setReview(false);
    setPlan(null);
    setError("");
    setMessage("");
  }
  async function uploadImage(file: File) {
    const request = ++imageUpload.current;
    setUploadingImage(true);
    setImageError("");
    generation.current++;
    setReview(false);
    setPlan(null);
    setError("");
    setMessage("");
    try {
      const image = await prepareTokenImage(file);
      if (request !== imageUpload.current) return;
      const uploaded = await api<{ image: string }>("/token-images", { image });
      if (request !== imageUpload.current) return;
      update("image", uploaded.image);
    } catch (error) {
      if (request === imageUpload.current) setImageError(errorMessage(error));
    } finally {
      if (request === imageUpload.current) setUploadingImage(false);
    }
  }
  function preflight() {
    if (uploadingImage) return;
    setError("");
    setMessage("");
    const result = launchSchema.safeParse(draft);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = String(issue?.path[0] ?? "");
      setInvalidField(field);
      setError(errorMessage(result.error));
      requestAnimationFrame(() => {
        const input = formRef.current?.elements.namedItem(field);
        if (input instanceof HTMLElement) input.focus();
      });
      return;
    }
    if (!config || !assets.some((asset) => sameAddress(asset.address, draft.quoteAddress)) || !status?.verified) {
      setError("Wait for the selected asset contract’s identity to be verified before continuing.");
      return;
    }
    setDraft(result.data);
    setPlan(null);
    setReview(true);
  }
  async function simulate() {
    const request = ++generation.current;
    activeSimulation.current = request;
    setError("");
    setMessage("");
    setPlan(null);
    setBusy(true);
    try {
      if (!wallet.account) throw new Error("Connect a wallet first");
      const next = await api<LaunchPlan>("/launch/prepare", {
        draft,
        creator: wallet.account,
      });
      if (request !== generation.current) return;
      if (next.feePolicy !== FEE_POLICY || !next.feeTreasury || !config?.treasury || !sameAddress(next.feeTreasury, config.treasury))
        throw new Error("The launch fee policy or treasury address does not match. Refresh and preview again.");
      assertOpeningValuation(next.openingValuation, stock.address, deploymentChain(config));
      setPlan(next);
      setMessage("On-chain simulation succeeded. No transaction has been sent.");
    } catch (e) {
      if (request === generation.current) setError(errorMessage(e));
    } finally {
      if (request === activeSimulation.current) {
        activeSimulation.current = null;
        setBusy(false);
      }
    }
  }
  async function register(hash: Hex) {
    const token = await api<TokenRecord>("/launch/register", { hash });
    if (config) updateTransaction(hash, config.chainId, { registered: true });
    setConfirmed(true);
    refresh();
    setMessage("The launch is confirmed on-chain and registered on the platform.");
    return token;
  }
  async function launch() {
    if (!plan || !config) return;
    setBusy(true);
    setError("");
    try {
      assertOpeningValuation(plan.openingValuation, stock.address, deploymentChain(config));
      if (!wallet.account || !sameAddress(plan.creator, wallet.account))
        throw new Error("The wallet has changed. Preview again.");
      const hash = await wallet.send(
        contractsFor(config).airlock,
        plan.data,
        config,
        (h) => {
          setTxHash(h);
          localStorage.setItem(pendingLaunchKey(config!), h);
          updateTransaction(h, config.chainId, { planId: plan.id });
          void api("/launch/track", { hash: h, planId: plan.id }).catch(() =>
            setMessage("The transaction hash is saved. Registration will be retried when you resume checking."),
          );
        },
      );
      const token = await register(hash);
      localStorage.removeItem(pendingLaunchKey(config!));
      navigate(`/token/${token.address}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    const hash =
      txHash ??
      (localStorage.getItem(
        pendingLaunchKey(config!),
      ) as Hex | null);
    if (!hash) {
      setError("There is no launch transaction to recover.");
      return;
    }
    setBusy(true);
    try {
      const token = await register(hash);
      localStorage.removeItem(pendingLaunchKey(config!));
      navigate(`/token/${token.address}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!config) return <Loading />;
  const chainName = networkName(config);
  const explorer = explorerFor(config);
  return (
    <>
      <div className="page-heading create-heading">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>
            Launch your token<span className="accent">.</span>
          </h1>
          <p>Give it a name and choose a quote asset. Preview your meme, then confirm the launch.</p>
        </div>
        <span className="pill">
          <span className="chain-mark" />
          {chainName} · Tokenized asset pairs
        </span>
      </div>
      <div className="create-layout launch-flow">
        <form
          id="launch-form"
          ref={formRef}
          className="form-column"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            preflight();
          }}
        >
          <section
            className="panel identity-panel"
            aria-labelledby="identity-heading"
          >
            <div className="panel-heading">
              <div>
                <h2 id="identity-heading">Give your meme an identity</h2>
                <p>The name and symbol cannot be changed after launch.</p>
              </div>
            </div>
            <div className="identity-fields">
              <button
                type="button"
                className="image-preview-button"
                aria-label={draft.image ? "Replace token image" : "Upload token image"}
                aria-describedby="token-image-help"
                aria-busy={uploadingImage}
                disabled={uploadingImage}
                onClick={() => imageInput.current?.click()}
              >
                {uploadingImage ? <LoaderCircle className="spin" size={28} /> : <TokenIcon name={draft.name} image={draft.image} />}
                <span>{uploadingImage ? "Uploading…" : draft.image ? "Replace image" : "Upload image"}</span>
              </button>
              <input ref={imageInput} type="file" accept={TOKEN_IMAGE_ACCEPT} hidden
                aria-label="Token image file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void uploadImage(file);
                }} />
              <div>
                <label>
                  Token name <span>*</span>
                  <input
                    name="name"
                    aria-label="Token name"
                    aria-describedby={
                      invalidField === "name" ? "launch-error-name" : undefined
                    }
                    aria-invalid={invalidField === "name"}
                    value={draft.name}
                    maxLength={32}
                    onChange={(e) => update("name", e.target.value)}
                    placeholder="For example: Nvidia Cat"
                    autoComplete="off"
                  />
                  <FieldError
                    name="name"
                    invalidField={invalidField}
                    error={error}
                  />
                </label>
                <label>
                  Token symbol <span>*</span>
                  <div className="input-prefix">
                    <span>$</span>
                    <input
                      name="symbol"
                      aria-label="Token symbol"
                      aria-describedby={
                        invalidField === "symbol"
                          ? "launch-error-symbol"
                          : undefined
                      }
                      aria-invalid={invalidField === "symbol"}
                      value={draft.symbol}
                      maxLength={10}
                      onChange={(e) =>
                        update("symbol", e.target.value.toUpperCase())
                      }
                      placeholder="NVCAT"
                      autoComplete="off"
                    />
                    <FieldError
                      name="symbol"
                      invalidField={invalidField}
                      error={error}
                    />
                  </div>
                </label>
              </div>
            </div>
            <p className="image-upload-help" id="token-image-help">PNG, JPG, WebP or GIF · Up to 5 MB. GIFs use the first frame.</p>
            {uploadingImage && <span className="image-upload-status" role="status">Uploading token image…</span>}
            {imageError && <span className="field-error" role="alert">{imageError}</span>}
            <label>
              Description <span className="optional">Optional</span>
              <textarea
                name="description"
                aria-label="Description"
                value={draft.description}
                maxLength={280}
                rows={3}
                placeholder="Your meme’s story starts here…"
                onChange={(e) => update("description", e.target.value)}
              />
              <span className="field-counter">
                {draft.description.length} / 280
              </span>
            </label>
            <label>
              Image URL <span className="optional">Optional · Upload an image or paste a public HTTPS URL</span>
              <input
                name="image"
                aria-label="Image URL"
                aria-describedby={
                  invalidField === "image" ? "launch-error-image" : undefined
                }
                aria-invalid={invalidField === "image"}
                type="url"
                value={draft.image}
                maxLength={500}
                placeholder="https://…/your-meme.png"
                onChange={(e) => update("image", e.target.value)}
              />
              <FieldError
                name="image"
                invalidField={invalidField}
                error={error}
              />
            </label>
            <div className="social-fields">
              <label>
                Website <span className="optional">Optional</span>
                <input
                  name="website"
                  aria-label="Website"
                  aria-describedby={
                    invalidField === "website"
                      ? "launch-error-website"
                      : undefined
                  }
                  aria-invalid={invalidField === "website"}
                  type="url"
                  value={draft.website ?? ""}
                  maxLength={500}
                  placeholder="https://"
                  onChange={(e) => update("website", e.target.value)}
                />
                <FieldError
                  name="website"
                  invalidField={invalidField}
                  error={error}
                />
              </label>
              <label>
                X / Twitter <span className="optional">Optional</span>
                <input
                  name="twitter"
                  aria-label="X / Twitter"
                  aria-describedby={
                    invalidField === "twitter"
                      ? "launch-error-twitter"
                      : undefined
                  }
                  aria-invalid={invalidField === "twitter"}
                  type="url"
                  value={draft.twitter ?? ""}
                  maxLength={500}
                  placeholder="https://x.com/…"
                  onChange={(e) => update("twitter", e.target.value)}
                />
                <FieldError
                  name="twitter"
                  invalidField={invalidField}
                  error={error}
                />
              </label>
              <label>
                Telegram <span className="optional">Optional</span>
                <input
                  name="telegram"
                  aria-label="Telegram"
                  aria-describedby={
                    invalidField === "telegram"
                      ? "launch-error-telegram"
                      : undefined
                  }
                  aria-invalid={invalidField === "telegram"}
                  type="url"
                  value={draft.telegram ?? ""}
                  maxLength={500}
                  placeholder="https://t.me/…"
                  onChange={(e) => update("telegram", e.target.value)}
                />
                <FieldError
                  name="telegram"
                  invalidField={invalidField}
                  error={error}
                />
              </label>
            </div>
          </section>
          <section className="panel" aria-labelledby="quote-heading">
            <div className="panel-heading">
              <div>
                <h2 id="quote-heading">Choose a quote asset</h2>
                <p>Buyers pay with the selected asset and sellers receive it.</p>
              </div>
            </div>
            <div className="launch-chain">
              <span className="pill">
                <span className="chain-mark" />
                {chainName}
              </span>
              <span>{assets.length} supported assets</span>
            </div>
            <div className="asset-categories" role="group" aria-label="Quote asset categories">
              {[{ id: "all", label: "All assets" }, ...ASSET_CATEGORIES].map((group) => {
                const count = group.id === "all" ? assets.length :
                  assets.filter((asset) => assetCategory(asset) === group.id).length;
                return count ? <button type="button" key={group.id}
                  aria-pressed={category === group.id}
                  onClick={() => { setCategory(group.id as AssetCategory); setShowAllAssets(false); }}>
                  {group.label}<span>{count}</span>
                </button> : null;
              })}
            </div>
            <div className="search-input stock-search">
              <Search size={17} />
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setShowAllAssets(false); }}
                placeholder="Search by name, symbol or contract address"
                aria-label="Search quote assets"
              />
            </div>
            {stockError && (
              <Notice kind="error">
                {stockError}{" "}
                <button type="button" onClick={refresh}>
                  Verify again
                </button>
              </Notice>
            )}
            <div className="asset-results">
              <span role="status">Showing {visibleAssets.length} of {matching.length} matching assets</span>
              {category !== "all" || query.trim() ? <button type="button" onClick={() => {
                setCategory("all"); setQuery(""); setShowAllAssets(false);
              }}>Clear filters</button> : null}
            </div>
            <div className="stock-grid" role="group" aria-label="Quote assets">
              {visibleAssets.map((s) => (
                <button
                  type="button"
                  className={`stock-option ${sameAddress(s.address, stock.address) ? "selected" : ""}`}
                  key={s.address}
                  aria-pressed={sameAddress(s.address, stock.address)}
                  onClick={() => update("quoteAddress", s.address)}
                >
                  <StockIcon stock={s} />
                  <span>
                    <b>{s.ticker}</b>
                    <small title={s.name}>{s.name}</small>
                  </span>
                  {sameAddress(s.address, stock.address) && (
                    <span className="selected-check">
                      <Check size={12} />
                    </span>
                  )}
                </button>
              ))}
            </div>
            {!query.trim() && matching.length > 12 && !showAllAssets && (
              <button type="button" className="secondary" onClick={() => setShowAllAssets(true)}>Show all {matching.length} assets</button>
            )}
            {matching.length === 0 && (
              <p className="muted center">No matching asset found</p>
            )}
            <div className="selected-quote">
              <StockIcon stock={stock} small />
              <div>
                <b>
                  {stock.name} · {stock.symbol}
                </b>
                <span>{stock.issuer}</span>
              </div>
              {explorer ? <External href={`${explorer}/token/${stock.address}`}>
                {shortAddress(stock.address)}
              </External> : <code>{shortAddress(stock.address)}</code>}
            </div>
            <p className="quote-explanation">
              Buyers pay {stock.symbol}, and you earn fees from trading. Your meme’s price reflects both trading supply and demand and the quote asset’s price.
            </p>
            {status?.error && (
              <Notice kind="error">
                {status.error}{" "}
                <button type="button" onClick={refresh}>
                  Verify again
                </button>
              </Notice>
            )}
            <details className="stock-verification">
              <summary>
                <ShieldCheck size={15} />
                {status?.verified
                  ? "Asset details · Contract identity verified"
                  : stocks
                    ? "Asset details · Verification failed"
                    : "Verifying the asset contract…"}
                <ChevronRight size={15} />
              </summary>
              <div className="stock-metadata">
                <div>
                  <b>{stock.symbol}</b>
                  <span>{stock.issuer} · {chainName} · {stock.standard}</span>
                </div>
                <External href={stock.sourceUrl}>Asset reference</External>
                {stock.standard === "B20" && <p>
                  1 {stock.symbol}{" "}
                  <StockShares
                    value={10n ** BigInt(stock.decimals)}
                    stock={stock}
                    status={status}
                  />
                </p>}
                <p>
                  On-chain supply:
                  {status?.verified && status.totalSupply !== null ? (
                    <>
                      <NumberText
                        value={status.totalSupply}
                        decimals={stock.decimals}
                      />{" "}
                      {stock.symbol}
                    </>
                  ) : (
                    "Unavailable"
                  )}
                </p>
                {status?.verified && (
                  <small>
                    Verified at block #{status.blockNumber} · Trades settle in token amounts.{stock.standard === "B20" ? " Share equivalents are indicative." : ""}
                  </small>
                )}
              </div>
            </details>
          </section>
        </form>
        <aside className="preview-column" aria-label="Live launch preview">
          <section className="preview-card">
            <div className="preview-header">
              <span>
                <span className="dot" />
                Live preview
              </span>
              <span className="base-label">
                <span className="chain-mark" />
                {chainName}
              </span>
            </div>
            <div className="meme-identity">
              <TokenIcon name={draft.name} image={draft.image} />
              <div>
                <h2>{draft.name || "Your token"}</h2>
                <span>${draft.symbol || "MEME"}</span>
              </div>
            </div>
            <p className="preview-description">
              {draft.description || "Add a description to introduce your meme."}
            </p>
            <SocialLinks token={draft} />
            <div className="pair-display">
              <span>Quote asset</span>
              <div>
                <StockIcon stock={stock} small />
                <b>{stock.symbol}</b>
              </div>
            </div>
            <div className="launch-outcome">
              <h3>What you launch</h3>
              <ul>
                <li>
                  <b>1,000,000,000 tokens</b>{" "}Fixed supply, all deposited into the pool
                </li>
                <li>
                  Opens at <b>{openingCapUsdLabel}</b> market cap
                </li>
                <li>
                  A trading pool settled in <b>{stock.symbol}</b>
                </li>
                <li>
                  Liquidity is <b>permanently locked</b>, with no graduation migration
                </li>
                <li>
                  Creator receives <b>{feePercent(FEE_SHARES.creatorNet)}</b> of net fees (after Doppler)
                </li>
                <li>
                  Platform receives <b>{feePercent(FEE_SHARES.platformNet)}</b> of net fees (after Doppler)
                </li>
                <li>
                  Platform income is allocated <b>{feePercent(FEE_SHARES.platformBuyback)}</b> to buybacks and <b>{feePercent(FEE_SHARES.platformOperations)}</b> to operations
                </li>
                <li>
                  Launch costs only <b>{chainName} network gas</b>
                </li>
              </ul>
            </div>
            <details className="curve-disclosure">
              <summary>
                How the launch curve works
                <ChevronRight size={15} />
              </summary>
              <Curve ticker={stock.symbol} fixedUsd />
              <p>
                All 1 billion tokens enter the pool: 90% spans $5,000 to $50,000 market cap, and 10% supplies the remaining liquidity. The curve uses the quote asset’s USD reference price at preview time. Tick rounding and later asset price changes may affect the USD market cap. Buys move the price up and sells move it down.
              </p>
            </details>
            <div className="fee-heading">
              <Coins size={16} />
              <h3>Earn your share of every trade</h3>
            </div>
            <FeeBreakdown policy={FEE_POLICY}>
              <Link href="/buyback" className="mechanism-link">View the buyback policy and status <ArrowUpRight size={14} /></Link>
            </FeeBreakdown>
          </section>
          <div className="preview-note">
            <ShieldCheck size={20} />
            <p>
              Review the parameters, simulate the launch, then confirm in your wallet. You retain control of your funds.
            </p>
          </div>
          <p className="asset-note">
            Transfers and redemptions of the quote asset follow the issuer’s rules. Your meme does not represent company equity.
          </p>
        </aside>
        <div className="launch-footer">
          <div className="draft-status">
            <span>
              {draftSaved ? "Draft saved automatically in this browser" : "Draft not saved yet"}
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                generation.current++;
                imageUpload.current++;
                setUploadingImage(false);
                setImageError("");
                setDraft(restoreDraft(null, config ?? undefined));
                setQuery("");
                setPlan(null);
                setReview(false);
                setError("");
                setInvalidField("");
                setMessage("Draft cleared. You can start a new launch.");
              }}
            >
              Clear draft
            </button>
          </div>
          {error && !review && !invalidField && (
            <Notice kind="error">{error}</Notice>
          )}
          {message && !review && <Notice kind="success">{message}</Notice>}
          <button
            type="submit"
            form="launch-form"
            className="primary full"
            disabled={busy || uploadingImage || !status?.verified}
          >
            Review and continue
            <ArrowRight size={17} />
          </button>
          <p className="launch-caption">
            Next, review your launch details. No transaction is sent yet.
          </p>
          {config?.blockReason && (
            <p className="launch-blocked">{config.blockReason}</p>
          )}
          {txHash && (
            <button
              className="text-button recovery"
              disabled={busy || confirmed}
              onClick={() => void recover()}
            >
              Recover pending launch
              <RefreshCw size={13} />
            </button>
          )}
        </div>
      </div>
      {review && (
        <dialog
          ref={reviewDialog}
          className="modal launch-review"
          aria-labelledby="launch-review-title"
          onCancel={(event) => {
            if (busy) event.preventDefault();
            else setReview(false);
          }}
          onClose={() => setReview(false)}
        >
          <button
            className="close-button"
            disabled={busy}
            aria-label="Back to edit"
            onClick={() => setReview(false)}
          >
            <X />
          </button>
          <span className="eyebrow">READY TO LAUNCH</span>
          <h2 id="launch-review-title">Review your launch</h2>
          <p>The name, symbol, and fee distribution are fixed after launch.</p>
          <div className="review-identity">
            <TokenIcon name={draft.name} image={draft.image} />
            <div>
              <h3>{draft.name}</h3>
              <span>
                ${draft.symbol} · {stock.symbol} pair
              </span>
            </div>
          </div>
          <dl className="review-facts">
            <div>
              <dt>Network / asset issuer</dt>
              <dd>{chainName} / {stock.issuer}</dd>
            </div>
            <div>
              <dt>Supply</dt>
              <dd>1 billion tokens · 100% in the pool</dd>
            </div>
            <div>
              <dt>Opening market cap</dt>
              <dd>
                Opens at <b>{openingCapUsdLabel}</b> market cap
              </dd>
            </div>
            <div>
              <dt>Net fee distribution (after Doppler)</dt>
              <dd>Creator {feePercent(FEE_SHARES.creatorNet)} · Platform {feePercent(FEE_SHARES.platformNet)}</dd>
            </div>
            <div>
              <dt>Total fee allocation equivalents</dt>
              <dd>Creator {feePercent(FEE_SHARES.creator)} · Buyback budget {feePercent(FEE_SHARES.buyback)} · Operating budget {feePercent(FEE_SHARES.operations)} · Doppler {feePercent(FEE_SHARES.protocol)}</dd>
            </div>
            <div>
              <dt>Buyback target / recipient</dt>
              <dd>Robinhood Chain MUSEGOD → {shortAddress(MUSEGOD_BUYBACK.burnAddress)}</dd>
            </div>
            <div>
              <dt>{chainName} platform treasury</dt>
              <dd>{config?.treasury ? shortAddress(config.treasury) : "Not configured"}</dd>
            </div>
            <div>
              <dt>Platform income allocation (platform income = 100%)</dt>
              <dd>{feePercent(FEE_SHARES.platformBuyback)} to buybacks and {feePercent(FEE_SHARES.platformOperations)} to operations, allocated manually by the treasury wallet</dd>
            </div>
            <div>
              <dt>Launch cost</dt>
              <dd>Network gas only</dd>
            </div>
          </dl>
          <div className="review-progress">
            <span className="complete">
              <Check size={14} />
              Parameter check
            </span>
            <ChevronRight size={14} />
            <span className={plan ? "complete" : ""}>On-chain simulation</span>
            <ChevronRight size={14} />
            <span>Wallet confirmation</span>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          {message && !planExpired && <Notice kind="success">{message}</Notice>}
          {plan && !planExpired && (
            <p className="launch-caption">
              Set using the quote asset’s USD reference price at preview time. This preview is valid for five minutes, including simulation time.
            </p>
          )}
          {planExpired && !busy && (
            <Notice kind="error">The launch preview has expired. Simulate again to refresh the quote asset’s USD reference price.</Notice>
          )}
          {wallet.error && <Notice kind="error">{wallet.error}</Notice>}
          {!wallet.account ? (
            <button
              className="primary full"
              disabled={wallet.connecting}
              onClick={() => void wallet.connect()}
            >
              {wallet.connecting ? "Connecting…" : "Connect wallet to continue"}
              <Wallet size={16} />
            </button>
          ) : !plan || (planExpired && !busy) ? (
            <button
              className="primary full"
              disabled={busy || !config?.treasury}
              onClick={() => void simulate()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}
              {busy ? "Simulating launch…" : planExpired ? "Simulate again" : "Simulate launch"}
            </button>
          ) : (
            <>
              <div className="plan-result">
                <CheckCircle2 size={16} />
                <span>
                  Simulation passed · Predicted token address
                  <br />
                  <code>{plan.tokenAddress}</code>
                </span>
              </div>
              <button
                className="primary full"
                disabled={busy || !config?.writesEnabled || wallet.chainId !== config.chainId}
                onClick={() => void launch()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Rocket size={17} />
                )}
                {busy ? "Waiting for confirmation…" : "Confirm launch · Sign in wallet"}
              </button>
            </>
          )}
          {config?.blockReason && (
            <p className="launch-blocked">{config.blockReason}</p>
          )}
          {txHash && config && <TxLink hash={txHash} config={config} />}
          <button
            className="text-button full"
            disabled={busy}
            onClick={() => setReview(false)}
          >
            Back to edit
          </button>
        </dialog>
      )}
    </>
  );
}

function TokenPage({
  address,
  config,
}: {
  address: string;
  config: RuntimeConfig | null;
}) {
  const generation = useRef(0);
  const directory = useResource<TokenRecord[]>("/tokens");
  const resource = useResource<{
      token: TokenRecord;
      state: { poolKey: V4PoolKey };
    }>(`/tokens/${address}`),
    stockResource = useResource<StockStatus[]>("/stocks"),
    wallet = useWallet();
  const [side, setSide] = useState<"buy" | "sell">("buy"),
    [amount, setAmount] = useState(""),
    [slippage, setSlippage] = useState(100),
    [quote, setQuote] = useState<Quote | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(""),
    [hash, setHash] = useState<Hex | null>(null),
    [balance, setBalance] = useState<bigint | null>(null),
    [copied, setCopied] = useState(false),
    [clock, setClock] = useState(Date.now());
  useEffect(() => {
    generation.current++;
    setQuote(null);
    setHash(null);
    setError("");
    setBusy(false);
    setProgress("");
    return () => {
      generation.current++;
    };
  }, [amount, side, slippage, wallet.revision, address]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    setBalance(null);
    if (wallet.account && resource.data)
      wallet
        .balance(
          side === "buy"
            ? resource.data.token.quoteAddress
            : resource.data.token.address,
        )
        .then((x) => {
          if (active) setBalance(x);
        })
        .catch((e) => {
          if (active) setError(`Could not load balance: ${errorMessage(e)}`);
        });
    return () => {
      active = false;
    };
  }, [wallet.account, wallet.revision, resource.data, side, hash]);
  const token =
    resource.data?.token ??
    directory.data?.find((t) => sameAddress(t.address, address));
  if (!token)
    return directory.error ? (
      <Notice kind="error">{directory.error}</Notice>
    ) : directory.data ? (
      <Notice kind="error">Token not found</Notice>
    ) : (
      <Loading />
    );
  const stock = quoteAsset(token),
    explorer = explorerFor(token),
    stockStatus = stockResource.data?.find((s) =>
      sameAddress(s.address, stock.address),
    ),
    inputDecimals = side === "buy" ? stock.decimals : 18,
    outputDecimals = side === "buy" ? 18 : stock.decimals,
    inputSymbol = side === "buy" ? stock.symbol : token.symbol,
    outputSymbol = side === "buy" ? token.symbol : stock.symbol;
  async function getQuote() {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setQuote(null);
    setHash(null);
    try {
      const next = await api<Quote>("/quote", {
        address,
        side,
        amount,
        slippageBps: slippage,
      });
      if (request === generation.current) setQuote(next);
    } catch (e) {
      if (request === generation.current) setError(errorMessage(e));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  async function execute() {
    if (!quote || !config) return;
    setBusy(true);
    setError("");
    try {
      const tx = await wallet.trade(quote, config, setProgress);
      setHash(tx);
      setQuote(null);
      setProgress("Transaction confirmed");
    } catch (e) {
      setError(errorMessage(e));
      setProgress("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link href="/" className="back-link">
        ← Back to explore
      </Link>
      <div className="token-title">
        <TokenIcon name={token.name} image={token.image} />
        <div>
          <h1>{token.name}</h1>
          <p>
            ${token.symbol} · {stock.symbol} pair
          </p>
        </div>
        <span className="pill">
          {token.mode === "fork" ? "Fork test asset" : token.mode === "robinhood" ? "Robinhood Chain" : "Base"}
        </span>
      </div>
      <div className="token-toolbar">
        <button
          className="text-button"
          onClick={() =>
            void navigator.clipboard
              .writeText(token.address)
              .then(() => setCopied(true))
              .catch(() => setError("Copy failed. Copy the address from the contract details."))
          }
        >
          <Copy size={13} />
          {copied ? "Copied" : shortAddress(token.address)}
        </button>
        <SocialLinks token={token} />
      </div>
      <div className="detail-layout token-trading-layout">
        <div>
          <TokenMarket token={token} refreshKey={hash ?? ""} />
          <section className="panel">
            <h2>About {token.name}</h2>
            <p className="body-copy">
              {token.description || "The creator has not added a description yet."}
            </p>
            <SocialLinks token={token} />
            <dl className="contract-list">
              <div>
                <dt>Token contract</dt>
                <dd>
                  {token.mode === "fork" ? (
                    <code>{shortAddress(token.address)}</code>
                  ) : (
                    <External
                      href={`${explorer}/token/${token.address}`}
                    >
                      {shortAddress(token.address)}
                    </External>
                  )}
                </dd>
              </div>
              <div>
                <dt>Quote asset</dt>
                <dd>
                  {explorer ? <External href={`${explorer}/token/${stock.address}`}>
                    {stock.symbol}
                  </External> : <code>{stock.symbol}</code>}
                </dd>
              </div>
              <div>
                <dt>Creator</dt>
                <dd>
                  {token.creator ? shortAddress(token.creator) : "Not verified"}
                </dd>
              </div>
              <div>
                <dt>Supply</dt>
                <dd>1,000,000,000</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{new Date(token.createdAt).toLocaleString("en-US")}</dd>
              </div>
            </dl>
            <h3>How fees are distributed</h3>
            <FeeBreakdown policy={token.feePolicy}>
              <Link href="/buyback" className="mechanism-link">View the buyback policy and status <ArrowUpRight size={14} /></Link>
            </FeeBreakdown>
            <details className="launch-curve-details">
              <summary>View launch curve</summary>
              <Curve ticker={stock.symbol} cap={token.openingCap} fixedUsd={token.openingValuation?.policy === OPENING_POLICY} />
            </details>
          </section>
          <FeeCard token={token} config={config} />
        </div>
        <section className="panel trade-panel" id="trade">
          <div className="trade-panel-heading">
            <h2>Trade {token.symbol}</h2>
            <span className="pill">{stock.symbol} pair</span>
          </div>
          <div className="trade-tabs">
            <button
              aria-pressed={side === "buy"}
              className={side === "buy" ? "active" : ""}
              disabled={busy}
              onClick={() => setSide("buy")}
            >
              Buy
            </button>
            <button
              aria-pressed={side === "sell"}
              className={side === "sell" ? "active sell" : ""}
              disabled={busy}
              onClick={() => setSide("sell")}
            >
              Sell
            </button>
          </div>
          {token.mode !== "fork" && (
            <div className="doppler-entry">
              {dopplerUrl(token) ? (
                <a
                  className="primary full"
                  href={dopplerUrl(token)!}
                  target="_blank"
                  rel="noreferrer"
                >
                  Trade on Doppler ↗
                </a>
              ) : (
                <p role="status">
                  Doppler trading is pending: the link opens after listing and quote verification.
                </p>
              )}
              <p>
                {config?.writesEnabled
                  ? "Get a quote here and confirm the trade in your wallet, or use the verified Doppler link."
                  : "This site provides read-only market data and on-chain quote previews. Transactions are currently disabled."}
              </p>
            </div>
          )}
          {resource.error && (
            <Notice kind="error">On-chain reads are unavailable: {resource.error}</Notice>
          )}
          <label className="trade-input">
            <span>
              You pay <b>{inputSymbol}</b>
            </span>
            <input
              aria-label="Trade input amount"
              disabled={busy}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
            <span className="balance">
              Balance:
              {balance === null ? (
                "—"
              ) : (
                <NumberText value={balance} decimals={inputDecimals} />
              )}
              {side === "buy" && balance !== null && (
                <StockShares
                  value={balance}
                  stock={stock}
                  status={stockStatus}
                />
              )}
            </span>
          </label>
          <div className="quick-amounts">
            {side === "buy"
              ? ["1", "5", "10"].map(
                  (value) => (
                    <button
                      key={value}
                      disabled={busy}
                      onClick={() => setAmount(value)}
                    >
                      {value} {stock.symbol}
                    </button>
                  ),
                )
              : [25, 50, 75].map((percent) => (
                  <button
                    key={percent}
                    disabled={busy || balance === null}
                    onClick={() =>
                      balance !== null &&
                      setAmount(
                        formatUnits(
                          (balance * BigInt(percent)) / 100n,
                          inputDecimals,
                        ),
                      )
                    }
                  >
                    {percent}%
                  </button>
                ))}
            <button
              disabled={busy || balance === null}
              onClick={() =>
                balance !== null &&
                setAmount(formatUnits(balance, inputDecimals))
              }
            >
              Max
            </button>
          </div>
          <div className="trade-arrow">
            <ArrowDown size={16} />
          </div>
          <div className="receive">
            <span>
              You receive (estimated) <b>{outputSymbol}</b>
            </span>
            <strong>
              {quote ? (
                <NumberText value={quote.amountOut} decimals={outputDecimals} />
              ) : (
                "—"
              )}
            </strong>
            {quote && side === "sell" && (
              <StockShares
                value={quote.amountOut}
                stock={stock}
                status={stockStatus}
              />
            )}
          </div>
          <label className="slippage">
            Maximum slippage
            <select
              aria-label="Maximum trade slippage"
              value={slippage}
              disabled={busy}
              onChange={(e) => setSlippage(Number(e.target.value))}
            >
              <option value={50}>0.5%</option>
              <option value={100}>1%</option>
              <option value={200}>2%</option>
              <option value={500}>5%</option>
            </select>
          </label>
          {quote && (
            <div className="quote-summary">
              <div>
                <span>Minimum received</span>
                <b>
                  <NumberText
                    value={minimumOutput(BigInt(quote.amountOut), slippage)}
                    decimals={outputDecimals}
                  />{" "}
                  {outputSymbol}
                </b>
              </div>
              <div>
                <span>Quote expires in</span>
                <b>
                  {Math.max(0, Math.ceil((quote.expiresAt - clock) / 1000))} seconds
                </b>
              </div>
            </div>
          )}
          <button
            className="secondary full"
            disabled={busy || !amount}
            onClick={() => void getQuote()}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            Get on-chain quote
          </button>
          {wallet.account ? (
            <button
              className="primary full"
              disabled={
                busy ||
                !quote ||
                clock >= quote.expiresAt ||
                !config?.writesEnabled ||
                wallet.chainId !== config.chainId
              }
              onClick={() => void execute()}
            >
              Confirm {side === "buy" ? "Buy" : "Sell"}
              <ArrowUpRight size={16} />
            </button>
          ) : (
            <button
              className="primary full"
              onClick={() => void wallet.connect()}
            >
              <Wallet size={16} />
              Connect wallet to trade
            </button>
          )}
          {config?.blockReason && (
            <p className="launch-blocked">{config.blockReason}</p>
          )}
          {error && <Notice kind="error">{error}</Notice>}
          {stockResource.error && (
            <Notice kind="error">
              Could not load the stock multiplier. The share equivalent is unavailable. {stockResource.error}
            </Notice>
          )}
          {progress && <Notice>{progress}</Notice>}
          {hash && config && <TxLink hash={hash} config={config} />}
          <p className="asset-note">
            Router approval is limited to this amount and valid for 5 minutes. Execution depends on slippage and liquidity and follows the stock token’s transfer rules.
          </p>
        </section>
      </div>
    </>
  );
}

type FeeData = {
  lp: { fees0: string; fees1: string };
  trade: { fees0: string; fees1: string };
  poolKey: V4PoolKey;
};
function FeeIncomeReference({ token, account, currency, amount }: {
  token: TokenRecord;
  account: Address;
  currency: Address;
  amount: string;
}) {
  const allocation = allocateFeeIncome({
    feePolicy: token.feePolicy,
    amount: BigInt(amount),
    account,
    creator: token.creator,
    treasury: token.feeTreasury,
  });
  if (!allocation || BigInt(amount) === 0n) return null;
  const asset = poolCurrency(currency, token);
  const parts = [
    { label: "Creator income", amount: allocation.creator },
    { label: "Buyback budget", amount: allocation.buyback },
    { label: "Operating allocation", amount: allocation.operations },
    { label: "Rounding remainder (retained)", amount: allocation.remainder },
  ].filter((part) => part.amount > 0n);
  return <div className="fee-allocation">
    <span>{asset.symbol} · Allocation reference after claiming</span>
    <dl>{parts.map((part) => <div key={part.label}>
      <dt>{part.label}</dt><dd>{formatUnits(part.amount, asset.decimals)} {asset.symbol}</dd>
    </div>)}</dl>
  </div>;
}
function FeeCard({
  token,
  config,
}: {
  token: TokenRecord;
  config: RuntimeConfig | null;
}) {
  const generation = useRef(0);
  const wallet = useWallet(),
    [data, setData] = useState<FeeData | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [hash, setHash] = useState<Hex | null>(null);
  useEffect(() => {
    generation.current++;
    setData(null);
    setError("");
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [wallet.revision, token.address]);
  async function check() {
    if (!wallet.account) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await api<FeeData>(
        `/fees/${token.address}?account=${wallet.account}`,
      );
      if (request === generation.current) setData(next);
    } catch (e) {
      if (request === generation.current) setError(errorMessage(e));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  async function claim(type: "trade" | "lp") {
    if (!config) return;
    setBusy(true);
    setError("");
    try {
      const contracts = contractsFor(config);
      const to = type === "trade" ? contracts.rehype : contracts.initializer;
      const data = encodeFunctionData({
        abi: claimFeesAbi,
        functionName: "collectFees",
        args: [token.poolId],
      });
      setHash(await wallet.send(to, data, config, (h) => setHash(h)));
      setData(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const symbol = (currency: Address) => poolCurrency(currency, token).symbol;
  const policy = feePolicyFor(token.feePolicy);
  const isTreasury = !!wallet.account && !!token.feeTreasury && sameAddress(token.feeTreasury, wallet.account);
  const isCreator = !!wallet.account && !!token.creator && sameAddress(token.creator, wallet.account);
  const incomeTitle = !policy ? "Beneficiary fees" : isTreasury
    ? isCreator ? (policy.operations > 0 ? "Creator and platform income" : "Creator income and buyback funds")
      : policy.operations > 0 ? "Platform income (buyback and operations)" : "Buyback funds"
    : isCreator ? "Creator income" : "Beneficiary fees";
  return (
    <section className="panel fee-panel">
      <div className="section-heading">
        <h2>
          <Coins size={20} /> {token.symbol} {incomeTitle}
        </h2>
        <button
          className="text-button"
          disabled={busy || !wallet.account}
          onClick={() => void check()}
        >
          <RefreshCw size={14} />
          Check fees
        </button>
      </div>
      <p className="muted">
        Amounts are queried for the connected wallet. Trading and LP fees are claimed separately and sent to the on-chain beneficiaries.
        {!policy ? " This pool has no identified fee policy. Only claimable on-chain amounts are shown, without estimating their allocation." : isTreasury
          ? `${isCreator ? ` The creator and platform share this address. First allocate the claimed amount ${feePercent(policy.creatorNet)} to the creator and ${feePercent(policy.platformNet)} to the platform.` : " This address claims platform income."}${policy.operations > 0 ? ` Then allocate platform income ${feePercent(policy.platformBuyback)} to buybacks and ${feePercent(policy.platformOperations)} to operations.` : " This pool retains its original policy: all platform income is allocated to the buyback budget."}`
          : ""}
      </p>
      {!wallet.account ? (
        <button className="secondary" onClick={() => void wallet.connect()}>
          Connect wallet to view
        </button>
      ) : data ? (
        <div className="fee-claims">
          {(["trade", "lp"] as const).map((type) => (
            <div key={type}>
              <span>{type === "trade" ? "Trading fee" : "LP fee"}</span>
              <b>
                <NumberText
                  value={data[type].fees0}
                  decimals={
                    poolCurrency(data.poolKey.currency0, token).decimals
                  }
                />{" "}
                {symbol(data.poolKey.currency0)}
              </b>
              <b>
                <NumberText
                  value={data[type].fees1}
                  decimals={
                    poolCurrency(data.poolKey.currency1, token).decimals
                  }
                />{" "}
                {symbol(data.poolKey.currency1)}
              </b>
              <FeeIncomeReference token={token} account={wallet.account!} currency={data.poolKey.currency0} amount={data[type].fees0} />
              <FeeIncomeReference token={token} account={wallet.account!} currency={data.poolKey.currency1} amount={data[type].fees1} />
              <button
                className="secondary"
                disabled={
                  busy ||
                  !config?.writesEnabled ||
                  wallet.chainId !== config.chainId ||
                  BigInt(data[type].fees0) + BigInt(data[type].fees1) === 0n
                }
                onClick={() => void claim(type)}
              >
                Claim
                <ArrowDownLeft size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">Click Check fees to read the current claimable on-chain amounts.</p>
      )}
      {data && policy && <p className="muted">Calculated for each asset using the creator and treasury recorded at launch, as a reference for manual allocation after claiming. Buyback budgets are rounded down and remainders are retained. Account for each pool separately. Check manually if protocol income is included or beneficiary rights have been transferred.</p>}
      {error && <Notice kind="error">{error}</Notice>}
      {hash && config && <TxLink hash={hash} config={config} />}
    </section>
  );
}
function Rewards({
  tokens,
  config,
}: {
  tokens: TokenRecord[];
  config: RuntimeConfig | null;
}) {
  const wallet = useWallet(),
    mine = tokens.filter(
      (t) =>
        wallet.account && (
          (t.creator && sameAddress(t.creator, wallet.account)) ||
          (t.feeTreasury && sameAddress(t.feeTreasury, wallet.account))
        ),
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CREATE. TRADE. EARN.</span>
          <h1>
            Every good meme earns its moment<span className="accent">.</span>
          </h1>
          <p>Every trade in your meme can accrue creator fees.</p>
        </div>
      </div>
      {!wallet.account ? (
        <div className="empty-state">
          <div className="empty-symbol">
            <Wallet size={28} />
          </div>
          <h3>Connect a wallet to view your rewards.</h3>
          <p>Fees remain on-chain until you claim them.</p>
          <button className="primary" onClick={() => void wallet.connect()}>
            Connect wallet
            <ArrowRight size={16} />
          </button>
        </div>
      ) : mine.length ? (
        mine.map((t) => <FeeCard key={t.address} token={t} config={config} />)
      ) : (
        <div className="empty-state">
          <div className="empty-symbol">
            <Coins size={28} />
          </div>
          <h3>No launches for this wallet yet</h3>
          <p>Launch a token with this wallet to manage its fees here.</p>
          <Link href="/create" className="primary">
            Launch your first token
            <Plus size={16} />
          </Link>
        </div>
      )}
      <div className="panel">
        <h2>How are fees distributed for new pools?</h2>
        <FeeBreakdown policy={FEE_POLICY}>
          <Link href="/buyback" className="mechanism-link">View the buyback policy and status <ArrowUpRight size={14} /></Link>
        </FeeBreakdown>
      </div>
    </>
  );
}
