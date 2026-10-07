import { useTokenCatalog } from "./lib/token-catalog";
import { PaymentPriceChanged } from "./lib/first-buy-wallet";
import TurnstileGate from "./components/TurnstileGate";
import LockRecovery from "./components/LockRecovery";
import { quoteNow } from "./lib/quote-clock";
import { activeLaunchIntent, newIntentId, selectLaunchIntent, savedLaunchIntents, launchIntentStorageKey, restoreLegacyPending, saveFrozenLaunch, withLaunchIntentLock, sentLaunchAwaitingRegistration } from "./lib/launch-intent";
import { LaunchPriceChanged, assertAcceptedLaunchRefresh, assertLaunchWalletPlan, launchDraftInput } from "./lib/launch-wallet";
import { assertLaunchPlanValidity } from "./lib/launch-plan";
import { dopplerUrl } from "./lib/doppler";
import TransactionHistory from "./components/TransactionHistory";
import { transactions, updateTransaction, saveTransaction } from "./lib/transactions";
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
  FEE_SHARES,
  MUSEGOD_BUYBACK,
  allocateFeeIncome,
  feePolicyFor,
  launchFeePolicy,
} from "./lib/fee-policy";
import {
  assetsFor,
  launchAssetsFor,
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
  SUPPLY,
  type RuntimeConfig,
  type Stock,
  type StockStatus,
  type TokenRecord,
} from "./lib/config";
import {
  errorMessage,
  amountSchema,
  launchSchema,
  minimumOutput,
  restoreDraft,
  parseAmount,
  safeImage,
  safeSocialLink,
  type LaunchInput,
} from "./lib/validation";
import { api, chainApi } from "./lib/api";
import { useNetwork, tokenPath } from "./lib/network";
import { firstBuyDraft, launchDraftKey, savedLaunchDraft, type FirstBuyDraft } from "./lib/launch-draft";
import FirstBuy from "./components/FirstBuy";
import FirstBuyLock from "./components/FirstBuyLock";
import { FIRST_BUY_SLIPPAGE_BPS, firstBuyPaymentAssets, assertFirstBuyPaymentQuote, type FirstBuyPrices, type FirstBuyPaymentQuote, type FirstBuyPaymentVerification } from "./lib/first-buy-payment";
import { resolveFirstBuyPayment, sameFirstBuyPayment, paymentMatchesLaunch, registeredLaunchConsumesPayment,
  type FirstBuyPaymentAttempt } from "./lib/first-buy-recovery";
import {
  OPENING_CAP_USD,
  assertOpeningValuation,
} from "./lib/opening-valuation";
import { TOKEN_IMAGE_ACCEPT } from "./lib/token-image";
import { prepareTokenImage } from "./lib/image-upload";
import { transactionClient, useWallet, type Quote } from "./lib/wallet";
import type { LaunchPlan } from "../server/store";
import { CURVE_POLICY, LAUNCH_CURVE_MAIN_END_USD } from "./lib/launch-curve";
import LaunchCurve from "./components/LaunchCurve";
import { pendingLaunchResolution, terminalLaunchIsCanonical, type PendingLaunchResolution } from "./lib/launch-wallet";

import TokenMarket from "./components/TokenMarket";
import MusegodPage from "./components/MusegodPage";
import { MUSEGOD } from "./lib/musegod";
import BuybackPage from "./components/BuybackPage";
import FeeBreakdown from "./components/FeeBreakdown";
import { LP_FEE_PPM, TRADING_FEE_BPS, tradingFeeBpsFor } from "./lib/trading-fee";
import { ASSET_CATEGORIES, assetCategory, type AssetCategory } from "./lib/asset-categories";
import assetLogos from "./lib/asset-logos.json";
import { buildIdentity } from "./lib/build-info";
import TokenCard from "./components/TokenCard";
import { useTokenCardMarkets } from "./lib/token-card-market";

function useResource<T>(path: string, version = 0) {
  const { chainId } = useNetwork();
  const scope = useRef(`${chainId}:${path}`);
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const nextScope = `${chainId}:${path}`;
    if (scope.current !== nextScope) { scope.current = nextScope; setData(null); }
    setError("");
    chainApi<T>(chainId, path)
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
  }, [path, version, chainId]);
  return { data, error, loading };
}
// Keep a user reading or editing supplied with fresh previews, without letting
// an abandoned or hidden tab consume the shared execution-quote budget.
function useQuoteActivity() {
  const lastInteraction = useRef(performance.now());
  const [active, setActive] = useState(document.visibilityState === "visible");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const remaining = 120_000 - (performance.now() - lastInteraction.current);
      const allowed = document.visibilityState === "visible" && remaining > 0;
      setActive(allowed);
      if (allowed) timer = setTimeout(update, remaining);
    };
    const interact = () => {
      lastInteraction.current = performance.now(); clearTimeout(timer);
      // Let an explicit Continue click enter its signing flow before reviving
      // background refresh; it already refreshes within the accepted bounds.
      timer = setTimeout(update, 250);
    };
    window.addEventListener("pointerdown", interact, { passive: true });
    window.addEventListener("keydown", interact);
    window.addEventListener("wheel", interact, { passive: true });
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", interact);
      window.removeEventListener("keydown", interact);
      window.removeEventListener("wheel", interact);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return active;
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
  const { chainId } = useNetwork();
  const target = ["/", "/create", "/rewards"].includes(href) ? `${href}?chainId=${chainId}` : href;
  return (
    <a
      href={target}
      {...rest}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          navigate(target);
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
  if (stock.standard !== "B20" && !status?.multiplierWad) return null;
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
function pendingLaunchKey(config: RuntimeConfig, account?: Address | null, intent?: string) {
  if (intent) return launchIntentStorageKey(config, account ?? null, intent, "pending");
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
type PaymentAttempt = FirstBuyPaymentAttempt;
function paymentKey(config: RuntimeConfig, account: Address, intent?: string) {
  if (intent) return launchIntentStorageKey(config, account, intent, "payment");
  return `musegod.first-buy.payment.${config.chainId}.${deploymentChain(config)}.${account.toLowerCase()}`;
}
function scopedApi(config: RuntimeConfig | null) {
  return <T,>(path: string, body?: unknown): Promise<T> => config
    ? chainApi<T>(deploymentChain(config), path, body)
    : Promise.reject(new Error("Wait for the network configuration to load."));
}

export function App() {
  const network = useNetwork();
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
    tokens = useTokenCatalog(version),
    wallet = useWallet();
  const current =
    path === "/create"
      ? "create"
      : path === "/rewards"
        ? "rewards"
        : path === "/buyback"
          ? "buyback"
          : "explore";
  const tokenAddress = path.startsWith("/token/") ? path.split("/").at(-1)! : null;
  useEffect(() => {
    if (/^\/token\/0x[0-9a-fA-F]{40}$/.test(path)) {
      const canonical = `/token/robinhood/${path.split("/")[2]}`;
      history.replaceState({}, "", canonical);
      setPath(canonical);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [path]);
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
            <select aria-label="Launch network" className="network-select" value={network.chainId}
              onChange={(event) => network.selectChain(Number(event.target.value) as 8453 | 4663)}>
              <option value={4663}>Robinhood Chain</option><option value={8453}>Base</option>
            </select>
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
          <TurnstileGate />
          <TransactionHistory config={config.data} />
          <LockRecovery config={config.data} />
          {!/^\/(?:create|rewards|buyback)?$/.test(path) &&
          !/^\/token\/(?:(?:base|robinhood)\/)?0x[0-9a-fA-F]{40}$/.test(path) ? (
            <section className="panel">
              <h1>Page not found</h1>
              <Link href="/">Back to home</Link>
            </section>
          ) : current === "create" ? (
            <CreatePage
              key={network.chainId}
              stocks={stocks.data}
              stockError={stocks.error}
              config={config.data ?? { chainId: network.chainId, mode: network.chainId === 4663 ? "robinhood" : "base",
                treasury: null, writesEnabled: false, blockReason: "Preparing this network. Your draft is available while the launch checks load." }}
              configurationPending={!config.data}
              refresh={() => setVersion((v) => v + 1)}
            />
          ) : current === "rewards" ? (
            <Rewards tokens={tokens.data ?? []} config={config.data} hasMore={!!tokens.nextCursor} loading={tokens.loading} loadMore={tokens.loadMore} />
          ) : current === "buyback" ? (
            <BuybackPage config={config.data} />
          ) : network.chainId === 4663 && tokenAddress && sameAddress(tokenAddress, MUSEGOD.token) ? (
            <MusegodPage config={config.data} navigate={navigate} />
          ) : tokenAddress ? (
            <TokenPage
              key={`${network.chainId}:${tokenAddress}`}
              address={tokenAddress}
              config={config.data}
            />
          ) : (
            <Explore
              key={network.chainId}
              tokens={tokens.data}
              tokenError={tokens.error}
              stocks={stocks.data}
              stockError={stocks.error}
              loading={tokens.loading}
              config={config.data}
              refreshVersion={version}
              hasMore={!!tokens.nextCursor}
              loadMore={tokens.loadMore}
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
export type ExploreToken = Pick<TokenRecord, "address" | "name" | "symbol" | "description" | "image" | "createdAt" | "mode" | "deploymentChainId" | "creator"> & {
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
      mode: token.mode, deploymentChainId: token.deploymentChainId, creator: token.creator, quote: quoteAsset(token),
    }));
  if (featured) {
    const quote = assetsFor({ mode: "robinhood" }).find((asset) => sameAddress(asset.address, MUSEGOD.weth))!;
    entries.push({ kind: "musegod", address: MUSEGOD.token, name: MUSEGOD.name,
      symbol: MUSEGOD.symbol, description: MUSEGOD.description, image: MUSEGOD.image,
      createdAt: MUSEGOD.createdAt, mode: config?.mode ?? "robinhood", deploymentChainId: 4663, creator: null, quote });
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
  hasMore = false,
  loadMore,
  refresh,
}: {
  tokens: TokenRecord[] | null;
  tokenError: string;
  stocks: StockStatus[] | null;
  stockError: string;
  loading: boolean;
  config: RuntimeConfig | null;
  refreshVersion?: number;
  hasMore?: boolean;
  loadMore?: () => void;
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
            <b>1%–3%</b>Trading fee at launch
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
      {loading && !tokens?.length && <Loading />}
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
      {hasMore && <button type="button" className="secondary full" disabled={loading} onClick={loadMore}>{loading ? "Loading more tokens…" : "Load more tokens"}</button>}
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
  configurationPending = false,
}: {
  stocks: StockStatus[] | null;
  stockError: string;
  config: RuntimeConfig | null;
  refresh: () => void;
  configurationPending?: boolean;
}) {
  const api = scopedApi(config);
  const generation = useRef(0);
  const activeSimulation = useRef<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null),
    imageInput = useRef<HTMLInputElement>(null),
    imageUpload = useRef(0),
    reviewDialog = useRef<HTMLDialogElement>(null);
  const wallet = useWallet();
  const initialSavedDraft = () => {
    if (!config) return savedLaunchDraft(config);
    const initialIntent = activeLaunchIntent(config, wallet.account);
    const scoped = localStorage.getItem(launchIntentStorageKey(config, wallet.account, initialIntent, "draft"));
    if (scoped) return scoped;
    const legacy = savedLaunchDraft(config);
    try {
      const prior = JSON.parse(legacy || "null");
      // A shared chain draft can migrate once, but must not overwrite another
      // wallet's existing independent intent.
      if (prior?.intentId && prior.intentId !== initialIntent && prior.intentId !== activeLaunchIntent(config, null)) return null;
    } catch { return null; }
    return legacy;
  };
  const
    [draft, setDraft] = useState<LaunchInput>(() => {
      try {
        return restoreDraft(initialSavedDraft(), config ?? undefined);
      } catch {
        return restoreDraft(null, config ?? undefined);
      }
    }),
    [firstBuy, setFirstBuy] = useState<FirstBuyDraft>(() => firstBuyDraft(config, initialSavedDraft()));
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
    [confirmed, setConfirmed] = useState(false),
    [paymentQuote, setPaymentQuote] = useState<FirstBuyPaymentQuote | null>(null),
    [paymentAttempt, setPaymentAttempt] = useState<PaymentAttempt | null>(null),
    [paymentBalance, setPaymentBalance] = useState<bigint | null>(null),
    [priceRevision, setPriceRevision] = useState(0);
  const [paymentExpired, setPaymentExpired] = useState(false);
  const [intentId, setIntentId] = useState(() => config ? activeLaunchIntent(config, wallet.account) : newIntentId());
  const [submissionUnknown, setSubmissionUnknown] = useState(false);
  const [recoveryHash, setRecoveryHash] = useState("");
  const currentPlan = useRef<LaunchPlan | null>(null);
  const inFlightIntents = useRef(new Set<string>());
  const draftScope = useRef(wallet.account?.toLowerCase() ?? "draft");
  const resolvedConfiguration = useRef(!configurationPending);
  useEffect(() => {
    if (!config) return;
    const next = activeLaunchIntent(config, wallet.account);
    const firstResolution = !configurationPending && !resolvedConfiguration.current;
    if (!configurationPending) resolvedConfiguration.current = true;
    const scope = wallet.account?.toLowerCase() ?? "draft";
    if (next !== intentId || draftScope.current !== scope) {
      const anonymous = draftScope.current === "draft";
      draftScope.current = scope; imageUpload.current++;
      generation.current++; setIntentId(next); currentPlan.current = null;
      setPlan(null); setPaymentQuote(null); setTxHash(null); setConfirmed(false); setBusy(false); setUploadingImage(false); setReview(false);
      const saved = localStorage.getItem(launchIntentStorageKey(config, wallet.account, next, "draft"));
      if (saved) { setDraft(restoreDraft(saved, config)); setFirstBuy(firstBuyDraft(config, saved)); }
      else if (!anonymous && !firstResolution) { setDraft(restoreDraft(null, config)); setFirstBuy(firstBuyDraft(config, null)); }
    }
  }, [config?.chainId, config?.deploymentChainId, wallet.account, configurationPending]);
  const tradingFeeBps = tradingFeeBpsFor(draft.tradingFeeBps);
  const assets = launchAssetsFor(config ?? undefined);
  const stock = assets.find((asset) => sameAddress(asset.address, draft.quoteAddress)) ?? assets[0],
    status = stocks?.find((s) => s.chainId === stock.chainId && sameAddress(s.address, stock.address)),
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
      assets.some((asset) => asset.chainId === s.chainId && sameAddress(asset.address, s.address)) &&
      (category === "all" || assetCategory(s) === category) &&
      `${s.ticker} ${s.symbol} ${s.name} ${s.address}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    );
  const visibleAssets = matching.slice(0, showAllAssets || query.trim() ? matching.length : 12);
  const paymentAssets = firstBuyPaymentAssets(stock.chainId, stock.address);
  const paymentAsset = paymentAssets.find((a) => sameAddress(a.address, firstBuy.payAddress)) ?? paymentAssets[0];
  const backgroundRefreshAllowed = useQuoteActivity();
  const refreshedPrice = useRef("");
  const refreshedPreview = useRef("");
  const paymentPrices = useResource<FirstBuyPrices>(`/first-buy/prices?pairedAsset=${stock.address}`, priceRevision);
  const paymentPrice = paymentPrices.data && paymentPrices.data.expiresAt > quoteNow(paymentPrices.data)
    ? paymentPrices.data.assets.find((a) => sameAddress(a.address, paymentAsset.address))?.priceUsd ?? null : null;
  const converting = !sameAddress(paymentAsset.address, stock.address) && /[1-9]/.test(firstBuy.amount);
  const converted = !!paymentAttempt?.actualOutput && sameAddress(paymentAttempt.quote.toToken.address, stock.address) &&
    sameAddress(paymentAttempt.quote.fromToken.address, paymentAsset.address) &&
    paymentAttempt.quote.amountIn === (() => { try { return parseAmount(firstBuy.amount, paymentAsset.decimals).toString(); } catch { return ""; } })();
  const paymentPairSupported = !paymentAttempt || assets.some((asset) => sameAddress(asset.address, paymentAttempt.quote.toToken.address));
  useEffect(() => {
    if (!backgroundRefreshAllowed || !paymentPrices.data) return;
    const snapshot = paymentPrices.data;
    const key = `${stock.address}:${snapshot.quotedAt}:${snapshot.expiresAt}`;
    const timer = setTimeout(() => {
      if (refreshedPrice.current === key) return;
      refreshedPrice.current = key; setPriceRevision((v) => v + 1);
    }, Math.max(0, snapshot.expiresAt - quoteNow(snapshot)));
    return () => clearTimeout(timer);
  }, [paymentPrices.data, backgroundRefreshAllowed, stock.address]);
  useEffect(() => {
    setPaymentExpired(!!paymentQuote && paymentQuote.expiresAt <= quoteNow(paymentQuote));
    if (!paymentQuote) return;
    const timer = setTimeout(() => setPaymentExpired(true), Math.max(0, paymentQuote.expiresAt - quoteNow(paymentQuote)));
    return () => clearTimeout(timer);
  }, [paymentQuote]);
  useEffect(() => {
    let active = true;
    setPaymentBalance(null);
    if (wallet.account && config) void (sameAddress(paymentAsset.address, "0x0000000000000000000000000000000000000000")
      ? wallet.balanceNative(config) : wallet.balance(paymentAsset.address, config)).then((balance) => {
        if (active) setPaymentBalance(balance);
      }).catch(() => {});
    return () => { active = false; };
  }, [wallet.account, wallet.revision, config?.chainId, config?.deploymentChainId, paymentAsset.address, paymentAttempt]);
  useEffect(() => {
    setPaymentAttempt(null);
    if (!wallet.account || !config) return;
    try {
      const key = paymentKey(config, wallet.account, intentId);
      const legacyKey = paymentKey(config, wallet.account);
      if (!localStorage.getItem(key) && localStorage.getItem(legacyKey)) {
        localStorage.setItem(key, localStorage.getItem(legacyKey)!); localStorage.removeItem(legacyKey);
      }
      const saved = JSON.parse(localStorage.getItem(key) || "null") as PaymentAttempt | null;
      if (saved) {
        assertFirstBuyPaymentQuote(saved.quote, quoteNow(saved.quote), true);
        if (saved.quote.chainId === deploymentChain(config) && sameAddress(saved.quote.account, wallet.account) && /^0x[\da-f]{64}$/i.test(saved.hash))
          setPaymentAttempt({ ...saved, actualOutput: null }); // Always reverify receipt after a reload.
      }
    } catch { /* Untrusted storage never establishes a successful conversion. */ }
  }, [wallet.account, wallet.revision, config?.chainId, config?.deploymentChainId, intentId]);
  useEffect(() => {
    generation.current++;
    setPlan(null);
    setPaymentQuote(null);
    setBusy(false);
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
    setFirstBuy((previous) => ({ ...previous, amount: "0", payAddress: assets[0].address, lockDays: 0 }));
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
    const remaining = (plan.signingExpiresAt ?? plan.openingValuation.expiresAt) - quoteNow(plan);
    setPlanExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setPlanExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [plan]);
  useEffect(() => {
    if (!config) return;
    setDraftSaved(false);
    const timer = setTimeout(() => {
      try {
        const payload = JSON.stringify({ ...draft, firstBuy, intentId });
        localStorage.setItem(launchDraftKey(config), payload);
        localStorage.setItem(launchIntentStorageKey(config, wallet.account, intentId, "draft"), payload);
        setDraftSaved(true);
      } catch {
        setDraftSaved(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, firstBuy, config?.chainId, config?.deploymentChainId, intentId, wallet.account]);
  useEffect(() => {
    if (!config) return;
    const syncSubmission = () => {
      try { setSubmissionUnknown(!!localStorage.getItem(launchIntentStorageKey(config, wallet.account, intentId, "submission"))); }
      catch { /* Keep unresolved recovery visible if storage becomes unavailable. */ }
    };
    try {
      setTxHash(restoreLegacyPending(config, wallet.account, intentId));
      syncSubmission();
      const backup = localStorage.getItem(launchIntentStorageKey(config, wallet.account, intentId, "plan"));
      currentPlan.current = backup ? JSON.parse(backup) : null;
    } catch {
      /* Storage may be unavailable. */
    }
    window.addEventListener("musegod:launch-submission", syncSubmission);
    window.addEventListener("storage", syncSubmission);
    return () => {
      window.removeEventListener("musegod:launch-submission", syncSubmission);
      window.removeEventListener("storage", syncSubmission);
    };
  }, [config?.chainId, config?.deploymentChainId, wallet.account, intentId]);
  useEffect(() => {
    if (!config || !txHash) return;
    let active = true;
    const check = async () => {
      const pendingKey = pendingLaunchKey(config, wallet.account, intentId);
      const markerKey = launchIntentStorageKey(config, wallet.account, intentId, "submission");
      let pendingValue: string | null, markerValue: string | null;
      try {
        pendingValue = localStorage.getItem(pendingKey); markerValue = localStorage.getItem(markerKey);
        const marker = JSON.parse(markerValue || "null") as { hash?: Hex } | null;
        if ((pendingValue && !sameAddress(pendingValue, txHash)) || (marker && (!marker.hash ||
          !sameAddress(marker.hash, txHash) && !sameAddress(pendingLaunchResolution(marker.hash, transactions(), config).hash, txHash)))) return;
      } catch { return; }
      const unchanged = () => active && localStorage.getItem(pendingKey) === pendingValue && localStorage.getItem(markerKey) === markerValue;
      const result = pendingLaunchResolution(txHash, transactions(), config);
      if (result.hash.toLowerCase() !== txHash.toLowerCase()) {
        if (!unchanged()) return;
        try { localStorage.setItem(pendingKey, result.hash); } catch { /* Transaction history still retains the replacement chain. */ }
        if (active) setTxHash(result.hash);
        return;
      }
      if (!result.terminal) return;
      const canonical = await terminalLaunchProof(result);
      if (!canonical || !unchanged()) return;
      try { localStorage.removeItem(pendingKey); } catch { /* The failed hash remains visible in transaction history. */ }
      localStorage.removeItem(markerKey);
      setSubmissionUnknown(false); setTxHash(null); setPlan(null);
    };
    const onChange = () => { void check(); };
    onChange();
    window.addEventListener("musegod:transactions", onChange);
    return () => { active = false; window.removeEventListener("musegod:transactions", onChange); };
  }, [txHash, config?.chainId, config?.deploymentChainId, intentId, wallet.account]);
  async function terminalLaunchProof(result: PendingLaunchResolution) {
    if (!config || !result.terminal || !wallet.account || !result.account || !sameAddress(result.account, wallet.account)) return false;
    const current = transactions().find((row) => sameAddress(row.hash, result.hash));
    if (current?.intentId && current.intentId !== intentId) return false;
    const client = transactionClient(config.chainId, config);
    if (await client.getChainId().catch(() => null) !== config.chainId) return false;
    return terminalLaunchIsCanonical(result, {
      receipt: (hash) => client.getTransactionReceipt({ hash }),
      transaction: (hash) => client.getTransaction({ hash }),
      head: () => client.getBlockNumber(), block: (blockNumber) => client.getBlock({ blockNumber }),
    });
  }
  function update<K extends keyof LaunchInput>(key: K, value: LaunchInput[K]) {
    if (draft[key] !== value) currentPlan.current = null;
    if (key === "image") {
      imageUpload.current++;
      setUploadingImage(false);
      setImageError("");
    }
    generation.current++;
    setDraft((d) => ({ ...d, [key]: value }));
    if (key === "quoteAddress" && !sameAddress(String(value), draft.quoteAddress))
      setFirstBuy((previous) => ({ ...previous, amount: "0", payAddress: String(value), lockDays: 0 }));
    if (key === "quoteAddress") setPaymentQuote(null);
    setInvalidField("");
    setReview(false);
    setPlan(null);
    setError("");
    setMessage("");
  }
  function updateFirstBuy(next: typeof firstBuy, keepReview = false) {
    if (paymentAttempt && !paymentAttempt.actualOutput) {
      setError("Check the submitted payment conversion before changing the first buy."); return;
    }
    generation.current++;
    if (next.amount !== firstBuy.amount || next.payAddress !== firstBuy.payAddress || next.slippageBps !== firstBuy.slippageBps || next.lockDays !== firstBuy.lockDays)
      currentPlan.current = null;
    setFirstBuy(next);
    setInvalidField("");
    if (!keepReview) setReview(false);
    setPlan(null);
    setPaymentQuote(null);
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
    if (uploadingImage || configurationPending) return;
    setError("");
    setMessage("");
    if (paymentAttempt && !paymentAttempt.actualOutput) {
      setError("Check the submitted payment conversion before preparing another launch."); return;
    }
    if (txHash && !confirmed) {
      setError("A launch transaction is already submitted. Recover its status before preparing another launch.");
      return;
    }
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
    if (!config || !assets.some((asset) => sameAddress(asset.address, draft.quoteAddress))) {
      setError("Wait for the selected asset contract’s identity to be verified before continuing.");
      return;
    }
    try {
      const amount = firstBuy.amount || "0";
      amountSchema.parse(amount);
      if ((amount.split(".")[1]?.length ?? 0) > paymentAsset.decimals)
        throw new Error(`The amount supports up to ${paymentAsset.decimals} decimal places`);
      if (Number(amount) !== 0) {
        parseAmount(amount, paymentAsset.decimals);
        if (!config.launchGuard) throw new Error("First buys are unavailable on this network. Set the amount to 0 to launch without a buy.");
        if (firstBuy.lockDays > 0 && !config.launchLockAvailable) throw new Error("Locked first buys are not yet enabled on this network. Choose No lock.");
      }
      if (!FIRST_BUY_SLIPPAGE_BPS.some((bps) => bps === firstBuy.slippageBps)) throw new Error("Choose a supported first buy slippage");
      setFirstBuy({ ...firstBuy, amount });
    } catch (e) {
      setInvalidField("firstBuy");
      setError(errorMessage(e));
      requestAnimationFrame(() => document.getElementById("launch-first-buy")?.focus());
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
      if (paymentAttempt && !paymentAttempt.actualOutput) throw new Error("Check the submitted payment conversion before preparing another launch.");
      if (txHash && !confirmed) throw new Error("Recover the submitted launch before preparing another launch.");
      if (config?.curvePolicy !== CURVE_POLICY)
        throw new Error("The launch curve policy has changed. Refresh this page before previewing.");
      let requestedAmount = firstBuy.amount;
      let conversionPreview: FirstBuyPaymentQuote | null = null;
      if (converting && !converted) {
        if (paymentAttempt) throw new Error("Check the submitted payment conversion before requesting another quote.");
        const quote = paymentQuote && paymentQuote.expiresAt - quoteNow(paymentQuote) >= 15_000 ? paymentQuote : await api<FirstBuyPaymentQuote>("/first-buy/quote", { account: wallet.account, fromToken: paymentAsset.address,
          toToken: stock.address, amount: firstBuy.amount, slippageBps: firstBuy.slippageBps });
        if (request !== generation.current) return;
        assertFirstBuyPaymentQuote(quote);
        conversionPreview = quote;
        requestedAmount = formatUnits(BigInt(quote.minimumOut), stock.decimals);
      }
      if (converted) {
        const payment = await api<FirstBuyPaymentVerification>("/first-buy/verify", { quote: paymentAttempt!.quote, hash: paymentAttempt!.hash });
        if (request !== generation.current) return;
        if (payment.status !== "success" || !payment.actualOutput) {
          setPaymentAttempt({ ...paymentAttempt!, actualOutput: null });
          throw new Error("The payment confirmation changed. Check the submitted payment before continuing.");
        }
        requestedAmount = formatUnits(BigInt(payment.actualOutput), stock.decimals);
        setPaymentAttempt({ ...paymentAttempt!, actualOutput: payment.actualOutput });
      }
      const next = await api<LaunchPlan>("/launch/prepare", {
        draft,
        creator: wallet.account,
        expectedCurvePolicy: CURVE_POLICY,
        options: { intentId, ...(currentPlan.current && currentPlan.current.draft.name === draft.name && currentPlan.current.draft.symbol === draft.symbol &&
          currentPlan.current.draft.quoteAddress === draft.quoteAddress && currentPlan.current.draft.tradingFeeBps === draft.tradingFeeBps &&
          currentPlan.current.draft.description === draft.description && currentPlan.current.draft.image === draft.image &&
          currentPlan.current.draft.website === draft.website && currentPlan.current.draft.twitter === draft.twitter && currentPlan.current.draft.telegram === draft.telegram &&
          (currentPlan.current.firstBuy?.lockDays ?? 0) === firstBuy.lockDays &&
          (currentPlan.current.firstBuy?.slippageBps ?? firstBuy.slippageBps) === firstBuy.slippageBps
          ? { ...((currentPlan.current.firstBuy?.amount ?? "0") === requestedAmount ? { previousPlanId: currentPlan.current.id } : {}),
            ...(currentPlan.current.firstBuy ? { acceptedMinAmountOut: currentPlan.current.firstBuy.acceptedMinAmountOut ?? currentPlan.current.firstBuy.minAmountOut } : {}) } : {}) },
        ...(paymentAttempt?.actualOutput ? { paymentRecovery: { quote: paymentAttempt.quote, hash: paymentAttempt.hash } } : {}),
        firstBuy: { amount: requestedAmount, slippageBps: firstBuy.slippageBps, lockDays: firstBuy.lockDays },
      });
      if (request !== generation.current) return;
      if (next.draft.tradingFeeBps !== tradingFeeBps)
        throw new Error("The trading fee does not match your selection. Preview again.");
      if (next.feePolicy !== launchFeePolicy(config) || !next.feeTreasury || !config?.treasury || !sameAddress(next.feeTreasury, config.treasury) ||
        (config.feeEngine ? !next.feeEngine || !sameAddress(next.feeEngine, config.feeEngine) : !!next.feeEngine))
        throw new Error("The launch fee policy or treasury address does not match. Refresh and preview again.");
      assertOpeningValuation(next.openingValuation, stock.address, deploymentChain(config), next.finalizedAt ?? quoteNow());
      if (next.curvePolicy !== CURVE_POLICY || !next.transaction)
        throw new Error("The launch curve policy does not match. Refresh and preview again.");
      const requestedBuy = Number(firstBuy.amount || "0") > 0;
      if (!!next.firstBuy !== requestedBuy || (next.firstBuy && (
        next.firstBuy.amountIn !== parseAmount(requestedAmount, stock.decimals).toString() ||
        next.firstBuy.slippageBps !== firstBuy.slippageBps ||
        (next.firstBuy.lockDays ?? 0) !== firstBuy.lockDays ||
        !sameAddress(next.firstBuy.quoteAddress, stock.address) || !sameAddress(next.firstBuy.recipient, wallet.account))))
        throw new Error("The first buy preview does not match your requested amount or wallet. Preview again.");
      currentPlan.current = next; saveFrozenLaunch(config!, wallet.account!, next); setPlan(next);
      setPaymentQuote(conversionPreview);
      setMessage(conversionPreview ? "Payment and first buy quoted together. Your token minimum stays fixed after confirmation." : next.firstBuy ? "First buy quoted. The complete transaction will be simulated after any required approval." : "On-chain simulation succeeded. No transaction has been sent.");
    } catch (e) {
      if (request === generation.current) setError(errorMessage(e));
    } finally {
      if (request === activeSimulation.current) {
        activeSimulation.current = null;
        if (request === generation.current) setBusy(false);
      }
    }
  }
  async function recoverPayment() {
    if (!config || !wallet.account || !paymentAttempt) return;
    const request = ++generation.current;
    const key = paymentKey(config, wallet.account, intentId);
    setBusy(true); setError("");
    try {
      const savedValue = localStorage.getItem(key);
      const unchanged = () => {
        if (localStorage.getItem(key) !== savedValue) throw new Error("The saved payment changed. Check its current status before continuing.");
      };
      const saved = JSON.parse(savedValue || "null") as PaymentAttempt | null;
      if (!saved || !sameFirstBuyPayment({ ...paymentAttempt, actualOutput: saved.actualOutput }, saved))
        throw new Error("The saved payment changed. Check its current status before continuing.");
      const client = transactionClient(config.chainId, config);
      const resolution = await resolveFirstBuyPayment(paymentAttempt.hash, paymentAttempt.quote, transactions(), config, {
        receipt: (hash) => client.getTransactionReceipt({ hash }), transaction: (hash) => client.getTransaction({ hash }),
        head: () => client.getBlockNumber(), block: (blockNumber) => client.getBlock({ blockNumber }),
      });
      if (request !== generation.current) return;
      unchanged();
      if (resolution.cancelled) {
        localStorage.removeItem(key); setPaymentAttempt(null); setPaymentQuote(null);
        setMessage("The payment was cancelled or replaced on-chain. You can request a new quote."); return;
      }
      const hash = resolution.hash;
      const result = await api<FirstBuyPaymentVerification>("/first-buy/verify", { quote: paymentAttempt.quote, hash });
      if (request !== generation.current) return;
      unchanged();
      if (result.status === "pending") throw new Error("The payment conversion is still pending. Check it again before continuing.");
      if (result.status === "reverted") {
        localStorage.removeItem(key); setPaymentAttempt(null); setPaymentQuote(null);
        setMessage("The payment conversion reverted. You can request a new quote."); return;
      }
      if (!result.actualOutput) throw new Error("The payment output could not be verified.");
      const next = { ...saved, hash: result.hash, actualOutput: result.actualOutput };
      if (next.launchHash && !sameFirstBuyPayment(saved, next)) delete next.launchHash;
      localStorage.setItem(key, JSON.stringify(next)); setPaymentAttempt(next); setPaymentQuote(null); setPlan(null);
      if (assets.some((asset) => sameAddress(asset.address, next.quote.toToken.address))) {
        setDraft((draft) => ({ ...draft, quoteAddress: next.quote.toToken.address }));
        setFirstBuy((old) => ({ ...old, payAddress: next.quote.fromToken.address, amount: formatUnits(BigInt(next.quote.amountIn), next.quote.fromToken.decimals) }));
        setMessage("Payment received and verified. Preview the launch using the actual paired-asset amount.");
      } else {
        setMessage(`Payment received and verified in ${next.quote.toToken.symbol}. This asset is unavailable for new launches; the received tokens stay in your wallet.`);
      }
    } catch (error) { if (request === generation.current) setError(errorMessage(error)); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function convertPayment(acceptedPlan = plan) {
    if (!config || !wallet.account || !paymentQuote || !acceptedPlan?.firstBuy || acceptedPlan.requiresReconfirmation || paymentAttempt) return;
    const request = generation.current, account = wallet.account;
    if (inFlightIntents.current.has(intentId)) return;
    inFlightIntents.current.add(intentId);
    let frozenPayment = { ...paymentQuote, intentId };
    setBusy(true); setError("");
    try {
      const paymentStorageKey = paymentKey(config, account, intentId);
      let paymentValue = localStorage.getItem(paymentStorageKey), paymentSaved = false;
      const current = () => {
        if (request !== generation.current) throw new Error("The draft or wallet changed. Preview again.");
        if (localStorage.getItem(paymentStorageKey) !== paymentValue)
          throw new Error("The saved payment changed. Check its current status before continuing.");
      };
      const result = await withLaunchIntentLock(config, account, intentId, () => wallet.payFirstBuy(frozenPayment, config,
        (message) => { if (request === generation.current) setMessage(message); }, (hash) => {
        if (localStorage.getItem(paymentStorageKey) !== paymentValue) return;
        const attempt = { quote: frozenPayment, hash, actualOutput: null, intentId };
        paymentValue = JSON.stringify(attempt); localStorage.setItem(paymentStorageKey, paymentValue); paymentSaved = true;
        if (request === generation.current) { setPaymentAttempt(attempt); setBusy(false); }
      }, current, (fresh) => { frozenPayment = { ...fresh, intentId }; if (request === generation.current) setPaymentQuote(frozenPayment); }));
      current();
      if (!paymentSaved) throw new Error("The saved payment changed. Check its current status before continuing.");
      if (result.status !== "success" || !result.actualOutput) throw new Error("Check the submitted payment status before continuing.");
      const attempt = { quote: frozenPayment, hash: result.hash, actualOutput: result.actualOutput, intentId };
      paymentValue = JSON.stringify(attempt); localStorage.setItem(paymentStorageKey, paymentValue);
      setPaymentAttempt(attempt); setPaymentQuote(null); setPlan(null);
      setMessage("Payment received. Preparing the launch with your selected limits…");
      const fundedPlan = await api<LaunchPlan>("/launch/prepare", { draft, creator: account, expectedCurvePolicy: CURVE_POLICY,
        firstBuy: { amount: formatUnits(BigInt(result.actualOutput), stock.decimals), slippageBps: firstBuy.slippageBps, lockDays: firstBuy.lockDays },
        paymentRecovery: { quote: frozenPayment, hash: result.hash },
        options: { intentId, acceptedMinAmountOut: acceptedPlan.firstBuy.acceptedMinAmountOut ?? acceptedPlan.firstBuy.minAmountOut } });
      current();
      if (!fundedPlan.firstBuy || fundedPlan.firstBuy.amountIn !== result.actualOutput)
        throw new Error("The final first buy does not match the verified payment output. Your payment is saved.");
      try {
        // Receipt output is the one field resolved after payment. Preserve every
        // other accepted condition, including the original meme-token floor.
        assertAcceptedLaunchRefresh({ ...acceptedPlan, firstBuy: { ...acceptedPlan.firstBuy,
          amount: fundedPlan.firstBuy.amount, amountIn: result.actualOutput } }, fundedPlan);
      } catch (cause) {
        if (!(cause instanceof LaunchPriceChanged)) throw cause;
        currentPlan.current = fundedPlan; saveFrozenLaunch(config, account, fundedPlan); setPlan(fundedPlan);
        setMessage("Payment received. Review the changed token minimum before launching."); return;
      }
      assertLaunchWalletPlan(fundedPlan, config, account);
      currentPlan.current = fundedPlan; saveFrozenLaunch(config, account, fundedPlan); setPlan(fundedPlan);
      inFlightIntents.current.delete(intentId);
      await launch(fundedPlan, attempt);
    } catch (error) {
      if (request === generation.current) {
        if (error instanceof PaymentPriceChanged) { setPaymentQuote(error.quote); setPlan(null); }
        setError(errorMessage(error));
      }
    }
    finally {
      inFlightIntents.current.delete(intentId);
      if (request === generation.current) {
        setSubmissionUnknown(!!localStorage.getItem(launchIntentStorageKey(config, account, intentId, "submission")));
        setBusy(false);
      }
    }
  }
  async function register(hash: Hex, request = generation.current, backup: LaunchPlan | null = currentPlan.current, stillCurrent = () => true) {
    const token = await api<TokenRecord>("/launch/register", { hash, ...(backup ? { recoveryPlan: backup } : {}) });
    if (config) updateTransaction(hash, config.chainId, { registered: true }, config.deploymentChainId);
    let consumedPayment = false;
    if (config && token.creator) {
      const key = paymentKey(config, token.creator, intentId);
      try {
        const savedValue = localStorage.getItem(key);
        const saved = JSON.parse(savedValue || "null") as PaymentAttempt | null;
        const launchTransaction = backup?.transaction;
        const recoverBinding = !!saved && !saved.launchHash && saved.intentId === intentId && saved.quote.intentId === intentId &&
          backup?.intentId === intentId && !!launchTransaction && sameAddress(token.address, backup.tokenAddress) &&
          paymentMatchesLaunch(saved, backup);
        if (saved && ((saved.launchHash && sameAddress(saved.launchHash, hash)) || recoverBinding)) {
          const verification = await api<FirstBuyPaymentVerification>("/first-buy/verify", { quote: saved.quote, hash: saved.hash });
          let bound = saved;
          if (recoverBinding && launchTransaction) {
            // A hash returned after a wallet timeout never ran onHash. Recover
            // that association only from the exact frozen calls and their order.
            const client = transactionClient(config.chainId, config);
            const [chainId, paymentTx, launchTx] = await Promise.all([
              client.getChainId(), client.getTransaction({ hash: saved.hash }), client.getTransaction({ hash }),
            ]);
            if (chainId !== config.chainId || !sameAddress(paymentTx.hash, saved.hash) || !sameAddress(launchTx.hash, hash) ||
              !sameAddress(paymentTx.from, saved.quote.account) || !sameAddress(launchTx.from, saved.quote.account) ||
              !paymentTx.to || !sameAddress(paymentTx.to, saved.quote.transaction.to) ||
              paymentTx.input.toLowerCase() !== saved.quote.transaction.data.toLowerCase() || paymentTx.value.toString() !== saved.quote.transaction.value ||
              !launchTx.to || !sameAddress(launchTx.to, launchTransaction.to) || launchTx.input.toLowerCase() !== launchTransaction.data.toLowerCase() ||
              launchTx.value.toString() !== launchTransaction.value || paymentTx.nonce >= launchTx.nonce ||
              !token.blockNumber || !/^\d+$/.test(token.blockNumber) || !verification.blockNumber || !/^\d+$/.test(verification.blockNumber) ||
              BigInt(verification.blockNumber) > BigInt(token.blockNumber))
              throw new Error("The saved payment could not be associated with this launch.");
            bound = { ...saved, launchHash: hash };
          }
          if (stillCurrent() && localStorage.getItem(key) === savedValue &&
            registeredLaunchConsumesPayment(bound, token, hash, verification)) {
            localStorage.removeItem(key);
            consumedPayment = true;
          }
        }
      } catch { /* Unknown payment evidence never blocks recovery of an already registered launch. */ }
    }
    if (request === generation.current && stillCurrent()) {
      if (consumedPayment) { setPaymentAttempt(null); setPaymentQuote(null); }
      setConfirmed(true);
      refresh(); setMessage("The launch is confirmed on-chain and registered on the platform.");
    }
    return token;
  }
  async function launch(selectedPlan?: LaunchPlan, fundedPayment?: PaymentAttempt) {
    const launchPlan = selectedPlan ?? plan;
    if (!launchPlan || !config) return;
    const activePlan = launchPlan;
    const flowPayment = fundedPayment ?? paymentAttempt;
    if (inFlightIntents.current.has(intentId)) return;
    inFlightIntents.current.add(intentId);
    let submittingPlan = activePlan;
    setBusy(true);
    setError("");
    const request = generation.current;
    const current = () => {
      if (request !== generation.current) throw new Error("The draft or wallet has changed. Run a new preview.");
    };
    try {
      if (converting && (!flowPayment?.actualOutput || !paymentMatchesLaunch(flowPayment, activePlan)))
        throw new Error("Complete and verify your selected payment conversion before launching. Your preview is saved.");
      if (flowPayment && !flowPayment.actualOutput) throw new Error("Check the submitted payment conversion before confirming another launch.");
      if (txHash && !confirmed) throw new Error("Recover the submitted launch before confirming another launch.");
      if ((activePlan.signingExpiresAt ?? activePlan.openingValuation?.expiresAt ?? 0) - quoteNow(activePlan) >= 60_000)
        assertLaunchPlanValidity(activePlan, deploymentChain(config), quoteNow(activePlan));
      if (activePlan.draft.tradingFeeBps !== tradingFeeBps)
        throw new Error("The trading fee changed. Preview again.");
      if (!wallet.account || !sameAddress(activePlan.creator, wallet.account))
        throw new Error("The wallet has changed. Preview again.");
      let consumed: PaymentAttempt | null = null;
      if (flowPayment && paymentMatchesLaunch(flowPayment, activePlan)) {
        const verified = await api<FirstBuyPaymentVerification>("/first-buy/verify", { quote: flowPayment.quote, hash: flowPayment.hash });
        current();
        if (verified.status !== "success" || !sameAddress(verified.hash, flowPayment.hash) ||
          verified.actualOutput !== flowPayment.actualOutput || !verified.blockNumber || !verified.blockHash) {
          setPaymentAttempt({ ...flowPayment, actualOutput: null });
          throw new Error("The payment confirmation changed. Check the submitted payment before continuing.");
        }
        consumed = structuredClone(flowPayment);
      }
      let submittedHash: Hex | undefined;
      const bindPayment = (hash: Hex, previous?: Hex) => {
        if (!consumed) return;
        try {
          const key = paymentKey(config, activePlan.creator, intentId);
          const saved = JSON.parse(localStorage.getItem(key) || "null") as PaymentAttempt | null;
          if (!saved || !sameFirstBuyPayment(saved, consumed) || !paymentMatchesLaunch(saved, activePlan) ||
            (previous ? !saved.launchHash || !sameAddress(saved.launchHash, previous) : !!saved.launchHash && !sameAddress(saved.launchHash, hash))) return;
          const bound = { ...saved, launchHash: hash };
          localStorage.setItem(key, JSON.stringify(bound));
          if (request === generation.current) setPaymentAttempt(bound);
        } catch { /* Keep the original payment record if association cannot be saved. */ }
      };
      currentPlan.current = activePlan;
      const hash = await withLaunchIntentLock(config, wallet.account, intentId, () => wallet.launch(
        activePlan,
        config,
        (message) => { if (request === generation.current) setMessage(message); },
        (h) => {
          submittedHash = h;
          bindPayment(h);
          if (request === generation.current) { setTxHash(h); setBusy(false); }
          localStorage.setItem(pendingLaunchKey(config!, wallet.account, intentId), h);
          updateTransaction(h, config.chainId, { planId: submittingPlan.id, intentId, tokenAddress: submittingPlan.tokenAddress }, config.deploymentChainId);
          void api("/launch/track", { hash: h, planId: submittingPlan.id }).catch(() => {
            if (request === generation.current) setMessage("The transaction hash is saved. Registration will be retried when you resume checking.");
          });
        },
        current,
        (next) => { submittingPlan = next; saveFrozenLaunch(config, wallet.account!, next);
          if (request === generation.current) { currentPlan.current = next; setPlan(next); } },
      ));
      if (submittedHash && !sameAddress(submittedHash, hash)) bindPayment(hash, submittedHash);
      const markerKey = launchIntentStorageKey(config, wallet.account, intentId, "submission");
      const pendingKey = pendingLaunchKey(config, wallet.account, intentId);
      const markerValue = localStorage.getItem(markerKey), pendingValue = localStorage.getItem(pendingKey);
      const marker = JSON.parse(markerValue || "null") as { hash?: Hex; planId?: Hex } | null;
      const ownsHash = (value?: string | null) => !value || sameAddress(value, hash) || !!submittedHash && sameAddress(value, submittedHash);
      if ((marker && (marker.planId !== submittingPlan.id || !marker.hash || !ownsHash(marker.hash))) || !ownsHash(pendingValue))
        throw new Error("The saved request changed. Check the current transaction before continuing.");
      const stillCurrent = () => request === generation.current && localStorage.getItem(markerKey) === markerValue &&
        localStorage.getItem(pendingKey) === pendingValue;
      const token = await register(hash, request, submittingPlan, stillCurrent);
      if (!stillCurrent()) throw new Error("The saved request changed. Check the current transaction before continuing.");
      localStorage.removeItem(pendingKey);
      localStorage.removeItem(markerKey);
      if (request !== generation.current) return;
      setSubmissionUnknown(false);
      navigate(tokenPath(token));
    } catch (e) {
      if (request !== generation.current) return;
      if (e instanceof LaunchPriceChanged) { currentPlan.current = e.plan; setPlan(e.plan); }
      if (currentPlan.current?.intentId) setSubmissionUnknown(!!localStorage.getItem(launchIntentStorageKey(config, wallet.account, intentId, "submission")));
      const mined = submittedLaunchInHistory();
      setError(mined ? "Your launch succeeded on-chain and is syncing to the catalog. Check its saved transaction; no new launch is needed." : errorMessage(e));
    } finally { inFlightIntents.current.delete(intentId); if (request === generation.current) setBusy(false); }
  }
  function submittedLaunchInHistory() {
    return transactions().some((row) => row.intentId === intentId && row.action === "launch" && row.status === "success");
  }
  async function recover() {
    if (!config || !wallet.account) return;
    const request = generation.current, backup = currentPlan.current;
    const markerKey = launchIntentStorageKey(config, wallet.account, intentId, "submission");
    const pendingKey = pendingLaunchKey(config, wallet.account, intentId);
    const paymentStorageKey = paymentKey(config, wallet.account, intentId);
    let markerValue: string | null, pendingValue: string | null, paymentValue: string | null;
    const stillCurrent = () => request === generation.current && localStorage.getItem(markerKey) === markerValue &&
      localStorage.getItem(pendingKey) === pendingValue;
    const unchanged = () => {
      if (!stillCurrent()) throw new Error("The saved request changed. Check the current transaction before continuing.");
    };
    let marker: { kind?: string; hash?: Hex; account?: Address; chainId?: number; deploymentChainId?: number;
      intentId?: string; planId?: Hex; transaction?: { to: Address; data: Hex; value: string }; quote?: FirstBuyPaymentQuote } | null;
    try {
      markerValue = localStorage.getItem(markerKey); pendingValue = localStorage.getItem(pendingKey);
      paymentValue = localStorage.getItem(paymentStorageKey); marker = JSON.parse(markerValue || "null");
    }
    catch { setError("The saved transaction could not be read. Keep this draft and its wallet transaction hash."); return; }
    const savedHash =
      (marker?.hash && /^0x[\da-f]{64}$/i.test(marker.hash) ? marker.hash : null) ?? txHash ??
      (localStorage.getItem(
        pendingLaunchKey(config!, wallet.account, intentId),
      ) as Hex | null) ?? (/^0x[\da-f]{64}$/i.test(recoveryHash) ? recoveryHash as Hex : null);
    if (!savedHash) {
      setError("Enter the transaction hash from your wallet to check the saved request.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const client = transactionClient(config!.chainId, config!);
      if (await client.getChainId() !== config.chainId) throw new Error("The transaction lookup RPC is on the wrong network.");
      const transaction = await client.getTransaction({ hash: savedHash });
      if (!wallet.account || !sameAddress(transaction.from, wallet.account)) throw new Error("This transaction belongs to another wallet. Your current launch is still saved.");
      if (marker?.kind === "approval") {
        const expected = marker.transaction;
        if (marker.intentId !== intentId || marker.chainId !== config.chainId || marker.deploymentChainId !== deploymentChain(config) ||
          !marker.account || !sameAddress(marker.account, wallet.account) || !expected || !transaction.to ||
          !sameAddress(transaction.to, expected.to) || transaction.input.toLowerCase() !== expected.data.toLowerCase() ||
          transaction.value.toString() !== expected.value)
          throw new Error("This hash does not match your saved approval. Its recovery is still protected.");
        const receipt = await client.getTransactionReceipt({ hash: savedHash });
        const [head, canonical] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), client.getBlock({ blockNumber: receipt.blockNumber })]);
        if (!sameAddress(receipt.from, wallet.account) || !receipt.to || !sameAddress(receipt.to, expected.to) ||
          canonical.hash !== receipt.blockHash || head < receipt.blockNumber + 1n)
          throw new Error("The approval is still confirming. Your draft stays saved and this approval will not be resent.");
        if (request !== generation.current) return;
        unchanged();
        saveTransaction({ hash: savedHash, chainId: config.chainId, deploymentChainId: deploymentChain(config), account: wallet.account,
          action: "approval", status: receipt.status === "success" ? "success" : "failed", intentId, planId: marker.planId,
          nonce: transaction.nonce, at: Date.now() });
        localStorage.removeItem(markerKey); setSubmissionUnknown(false); setRecoveryHash("");
        setMessage(receipt.status === "success" ? "Approval confirmed. Your draft is saved; continue when you are ready."
          : "The approval reverted. Your draft is saved; review it before trying again.");
        return;
      }
      if (marker?.kind === "payment" && marker.quote) {
        const original = marker.quote as FirstBuyPaymentQuote;
        if (!transaction.to || !sameAddress(transaction.to, original.transaction.to) || transaction.input.toLowerCase() !== original.transaction.data.toLowerCase() || transaction.value.toString() !== original.transaction.value)
          throw new Error("This hash does not match your saved payment. Your payment recovery is still protected.");
        const result = await api<FirstBuyPaymentVerification>("/first-buy/verify", { quote: original, hash: savedHash });
        unchanged();
        if (localStorage.getItem(paymentStorageKey) !== paymentValue)
          throw new Error("The saved payment changed. Check its current status before continuing.");
        if (result.status === "pending") throw new Error("Your payment is still confirming. You can create another token while it is checked.");
        if (result.status === "success") {
          const previous = JSON.parse(paymentValue || "null") as PaymentAttempt | null;
          const recovered = { ...previous, quote: original, hash: result.hash, actualOutput: result.actualOutput, intentId };
          if (previous && !sameFirstBuyPayment({ ...recovered, actualOutput: previous.actualOutput }, previous))
            throw new Error("The saved payment changed. Check its current status before continuing.");
          if (recovered.launchHash && previous && !sameFirstBuyPayment(previous, recovered)) delete recovered.launchHash;
          localStorage.setItem(paymentStorageKey, JSON.stringify(recovered));
          if (request === generation.current) { setPaymentAttempt(recovered); setPaymentQuote(null); }
        }
        localStorage.removeItem(markerKey);
        if (request === generation.current) { setSubmissionUnknown(false); setMessage("Payment checked. Your draft and tokens are saved."); } return;
      }
      const row = transactions().find((entry) => sameAddress(entry.hash, savedHash));
      if (backup ? !transaction.to || !backup.transaction || !sameAddress(transaction.to, backup.transaction.to) ||
        transaction.input.toLowerCase() !== backup.data.toLowerCase() || transaction.value.toString() !== backup.transaction.value
        : !row || row.intentId !== intentId || !sameAddress(row.account, wallet.account))
        throw new Error("This hash does not match this saved launch. Your original launch remains protected.");
      const result = pendingLaunchResolution(savedHash, transactions(), config!);
      if (await terminalLaunchProof(result)) {
        unchanged();
        localStorage.removeItem(pendingKey);
        localStorage.removeItem(markerKey);
        if (request !== generation.current) return;
        setSubmissionUnknown(false);
        setTxHash(null); setPlan(null);
        setMessage("The launch did not complete on-chain. You can prepare a new preview.");
        return;
      }
      unchanged();
      const hash = result.hash;
      if (hash.toLowerCase() !== savedHash.toLowerCase()) {
        if (request === generation.current) setTxHash(hash);
        localStorage.setItem(pendingKey, hash); pendingValue = hash;
      }
      const token = await register(hash, request, backup, stillCurrent);
      unchanged();
      localStorage.removeItem(pendingKey);
      localStorage.removeItem(markerKey);
      if (request !== generation.current) return;
      setSubmissionUnknown(false);
      navigate(tokenPath(token));
    } catch (e) {
      if (request === generation.current) setError(errorMessage(e));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (review && wallet.account && config && activeLaunchIntent(config, wallet.account) === intentId && !busy && !txHash && !submissionUnknown && !plan && !paymentQuote && !paymentAttempt)
      void simulate();
  }, [review, wallet.account, intentId]);
  useEffect(() => {
    if (!backgroundRefreshAllowed || !review || busy || txHash || submissionUnknown || paymentAttempt) return;
    const expired = plan && (plan.signingExpiresAt ?? plan.openingValuation?.expiresAt ?? 0) <= quoteNow(plan) ||
      paymentQuote && paymentQuote.expiresAt <= quoteNow(paymentQuote);
    const key = `${plan?.id}:${plan?.signingExpiresAt ?? plan?.openingValuation?.expiresAt}:${paymentQuote?.id}:${paymentQuote?.expiresAt}`;
    if (!expired || refreshedPreview.current === key) return;
    refreshedPreview.current = key; void simulate();
  }, [review, busy, txHash, submissionUnknown, paymentAttempt, planExpired, paymentExpired, plan, paymentQuote, backgroundRefreshAllowed]);
  function resumeIntent(next: string) {
    if (!config || busy) return;
    localStorage.setItem(launchIntentStorageKey(config, wallet.account, intentId, "draft"), JSON.stringify({ ...draft, firstBuy, intentId }));
    selectLaunchIntent(config, wallet.account, next); generation.current++; imageUpload.current++; currentPlan.current = null;
    const saved = localStorage.getItem(launchIntentStorageKey(config, wallet.account, next, "draft"));
    setUploadingImage(false);
    setIntentId(next); setDraft(restoreDraft(saved, config)); setFirstBuy(firstBuyDraft(config, saved));
    setPaymentAttempt(null); setPaymentQuote(null); setPlan(null); setTxHash(null); setConfirmed(false); setSubmissionUnknown(false);
    setError(""); setMessage(saved ? "Your saved launch is restored. Check its submitted transaction before continuing." : "Your previous launch is saved. Start your next token here."); setReview(false);
  }
  function startAnotherLaunch() {
    resumeIntent(newIntentId());
  }
  async function acceptPriceChange() {
    if (!config || !wallet.account || !plan?.firstBuy || busy) return;
    const request = generation.current;
    const floor = (BigInt(plan.firstBuy.expectedAmountOut) * BigInt(10_000 - plan.firstBuy.slippageBps) / 10_000n).toString();
    setBusy(true); setError("");
    try {
      const next = await api<LaunchPlan>("/launch/prepare", { draft: launchDraftInput(plan), creator: wallet.account,
        expectedCurvePolicy: CURVE_POLICY, options: { intentId, previousPlanId: plan.id, reconfirmPrice: true, reconfirmedMinimumOut: floor },
        firstBuy: { amount: plan.firstBuy.amount, slippageBps: plan.firstBuy.slippageBps, lockDays: plan.firstBuy.lockDays ?? 0 },
        ...(paymentAttempt?.actualOutput ? { paymentRecovery: { quote: paymentAttempt.quote, hash: paymentAttempt.hash } } : {}) });
      saveFrozenLaunch(config, wallet.account, next);
      if (request !== generation.current) return;
      currentPlan.current = next; setPlan(next);
      if (next.requiresReconfirmation) setError("The price moved again. Review the updated minimum before continuing.");
      else if (converting && !converted) await convertPayment(next);
      else await launch(next);
    } catch (cause) { if (request === generation.current) setError(errorMessage(cause)); }
    finally { if (request === generation.current) setBusy(false); }
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
      {savedLaunchIntents(config, wallet.account).some((saved) => saved.intentId !== intentId) && <details className="panel">
        <summary>Saved launches</summary>
        <ul>{savedLaunchIntents(config, wallet.account).filter((saved) => saved.intentId !== intentId).map((saved) => <li key={saved.intentId}>
          {saved.name} · {saved.pending ? "Awaiting transaction recovery" : "Saved draft"}{" "}
          <button type="button" className="secondary" disabled={busy} onClick={() => resumeIntent(saved.intentId)}>Resume {saved.name}</button>
        </li>)}</ul>
      </details>}
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
          <FirstBuy value={firstBuy} asset={paymentAsset} assets={paymentAssets} balance={paymentBalance} price={paymentPrice}
            lockAvailable={!!config.launchLockAvailable} busy={busy || (!!paymentAttempt && !paymentAttempt.actualOutput)}
            error={invalidField === "firstBuy" ? error : ""} onChange={updateFirstBuy} />
          <section className="panel trading-fee-panel" aria-labelledby="trading-fee-heading">
            <h2 id="trading-fee-heading">Trading fee</h2>
            <div className="trading-fee-options" role="radiogroup" aria-label="Trading fee" aria-describedby="trading-fee-help">
              {TRADING_FEE_BPS.map((bps, index) => <button type="button" role="radio" key={bps}
                name="tradingFeeBps" value={bps} aria-checked={tradingFeeBps === bps}
                tabIndex={tradingFeeBps === bps ? 0 : -1}
                disabled={busy || (!!paymentAttempt && !paymentAttempt.actualOutput)}
                onClick={() => update("tradingFeeBps", bps)}
                onKeyDown={(event) => {
                  let next: number;
                  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % TRADING_FEE_BPS.length;
                  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + TRADING_FEE_BPS.length - 1) % TRADING_FEE_BPS.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = TRADING_FEE_BPS.length - 1;
                  else return;
                  event.preventDefault();
                  update("tradingFeeBps", TRADING_FEE_BPS[next]);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
                }}>{feePercent(bps)}</button>)}
            </div>
            <p className="muted" id="trading-fee-help">Trades after launch pay {feePercent(tradingFeeBps)}, plus a 0.05% LP fee. The trading fee is fixed when the pool is created and cannot be changed afterwards. A higher fee increases earnings per trade and costs traders more.</p>
          </section>
          {paymentAttempt && <section className="panel payment-recovery" aria-label="First buy payment status">
            <h3>{paymentAttempt.actualOutput ? "Payment received" : "Submitted payment conversion"}</h3>
            {paymentAttempt.actualOutput && <p>{formatUnits(BigInt(paymentAttempt.actualOutput), paymentAttempt.quote.toToken.decimals)} {paymentAttempt.quote.toToken.symbol} verified in your wallet. {paymentPairSupported ? "Preview the launch using this amount." : "This asset is unavailable for new launches. These tokens stay in your wallet."}</p>}
            <TxLink hash={paymentAttempt.hash} config={config} />
            <button type="button" className="secondary" disabled={busy} onClick={() => void recoverPayment()}><RefreshCw size={14} /> Check payment status</button>
            {paymentAttempt.actualOutput && <button type="button" className="text-button" disabled={busy} onClick={() => {
              if (!wallet.account) return;
              generation.current++;
              if (paymentPairSupported) setDraft((draft) => ({ ...draft, quoteAddress: paymentAttempt.quote.toToken.address }));
              setFirstBuy(paymentPairSupported ? { ...firstBuy, payAddress: paymentAttempt.quote.toToken.address,
                amount: formatUnits(BigInt(paymentAttempt.actualOutput!), paymentAttempt.quote.toToken.decimals) }
                : { ...firstBuy, payAddress: stock.address, amount: "0", lockDays: 0 });
              setPlan(null); setPaymentQuote(null); setPaymentAttempt(null);
              localStorage.removeItem(paymentKey(config, wallet.account, intentId));
              setMessage(paymentPairSupported ? "Use the paired asset in your wallet directly. You can adjust the first buy amount."
                : `${paymentAttempt.quote.toToken.symbol} stays in your wallet. Choose a new first buy for the current paired asset.`);
            }}>{paymentPairSupported ? "Use paired asset directly" : "Keep tokens and start a new first buy"}</button>}
            <p className="muted">A completed conversion stays in your wallet if you cancel or the launch fails. This check never sends another conversion.</p>
          </section>}
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
                  Targets <b>{openingCapUsdLabel}</b> before the first buy
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
                  {Number(firstBuy.amount || "0") > 0 ? <>Optional first buy plus <b>{chainName} network gas</b></> : <>Launch costs only <b>{chainName} network gas</b></>}
                </li>
              </ul>
            </div>
            <details className="curve-disclosure">
              <summary>
                How the launch curve works
                <ChevronRight size={15} />
              </summary>
              <LaunchCurve ticker={stock.symbol} curvePolicy={CURVE_POLICY}
                openingValuation={plan?.openingValuation} quoteDecimals={stock.decimals}
                tokenAddress={plan?.tokenAddress} quoteAddress={stock.address} />
              <p>
                All 1 billion tokens enter the pool: 97% spans {openingCapUsdLabel} to ${LAUNCH_CURVE_MAIN_END_USD.toLocaleString("en-US")} market cap across 18 adjacent price doublings. The remaining 3% supplies a higher price tail with a finite limit. The initial positions are fixed at launch. A LI.FI buy/sell quote reference sets the initial valuation and expires after 60 seconds. Tick rounding, the optional first buy and later asset price changes affect USD market cap. Buys move the price up and sells move it down.
              </p>
            </details>
            <div className="fee-heading">
              <Coins size={16} />
              <h3>Earn your share of every trade</h3>
            </div>
            <FeeBreakdown policy={launchFeePolicy(config)} tradingFeeBps={tradingFeeBps}>
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
            Stock Tokens carry issuer, liquidity and jurisdiction risks; <a href="https://docs.robinhood.com/rhj/" target="_blank" rel="noreferrer">review the issuer’s terms</a>. Your meme does not represent company equity.
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
              disabled={busy || (!!paymentAttempt && !paymentAttempt.actualOutput)}
              onClick={() => {
                generation.current++;
                imageUpload.current++;
                setUploadingImage(false);
                setImageError("");
                currentPlan.current = null; setDraft(restoreDraft(null, config ?? undefined));
                setFirstBuy({ amount: "0", slippageBps: 100, payAddress: launchAssetsFor(config)[0].address, lockDays: 0 });
                setPaymentQuote(null);
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
          {(txHash || submissionUnknown) && !confirmed && <Notice>Your previous launch is being checked. Its payment and transaction are saved.</Notice>}
          {(txHash || submissionUnknown || paymentAttempt && !paymentAttempt.actualOutput) && <button type="button" className="secondary full" disabled={busy} onClick={startAnotherLaunch}>Create another token</button>}
          {submissionUnknown && !txHash && <label>Transaction hash from your wallet<input value={recoveryHash} onChange={(event) => setRecoveryHash(event.target.value)} placeholder="0x…" /></label>}
          <button
            type="submit"
            form="launch-form"
            className="primary full"
            disabled={busy || !!txHash || submissionUnknown || uploadingImage || configurationPending}
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
          {(txHash || submissionUnknown) && (
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
          <p>The name, symbol, trading fee, and fee distribution are fixed after launch.</p>
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
              <dt>Initial valuation target</dt>
              <dd>
                <b>{openingCapUsdLabel}</b> before the first buy
              </dd>
            </div>
            <div>
              <dt>Opening price reference</dt>
              <dd>Fresh LI.FI reference · 5-minute wallet window</dd>
            </div>
            <div>
              <dt>Net fee distribution (after Doppler)</dt>
              <dd>Creator {feePercent(FEE_SHARES.creatorNet)} · Platform {feePercent(FEE_SHARES.platformNet)}</dd>
            </div>
            <div>
              <dt>Trading fee</dt>
              <dd>{feePercent(tradingFeeBps)} · Fixed after launch</dd>
            </div>
            <div>
              <dt>Nominal total fee</dt>
              <dd>{(tradingFeeBps + LP_FEE_PPM / 100) / 100}% including the 0.05% LP fee</dd>
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
              <dd>{feePercent(FEE_SHARES.platformBuyback)} to buybacks and {feePercent(FEE_SHARES.platformOperations)} to operations{config.feeEngine ? ", split directly between the public engine and treasury" : ", allocated manually by the treasury wallet"}</dd>
            </div>
            <div>
              <dt>Launch cost</dt>
              <dd>{Number(firstBuy.amount || "0") > 0 ? `${firstBuy.amount} ${paymentAsset.symbol} + network gas` : "Network gas only"}</dd>
            </div>
            {Number(firstBuy.amount || "0") > 0 && <div>
              <dt>First buy slippage</dt><dd>{firstBuy.slippageBps / 100}%</dd>
            </div>}
          </dl>
          {Number(firstBuy.amount || "0") > 0 && <div className="first-buy-slippage">
            <span>Slippage per conversion / first buy</span><div role="group" aria-label="First buy slippage tolerance">
              {FIRST_BUY_SLIPPAGE_BPS.map((bps) => <button type="button" key={bps} aria-pressed={firstBuy.slippageBps === bps}
                disabled={busy || !!paymentAttempt} onClick={() => updateFirstBuy({ ...firstBuy, slippageBps: bps }, true)}>{bps / 100}%</button>)}
            </div>
          </div>}
          {paymentQuote && <section className="first-buy-preview" aria-label="Payment conversion review">
            <h3>{paymentQuote.protocol === "wrap" ? "Wrap ETH into WETH" : "Convert payment with LI.FI"}</h3><dl className="review-facts">
              <div><dt>You pay</dt><dd>{formatUnits(BigInt(paymentQuote.amountIn), paymentQuote.fromToken.decimals)} {paymentQuote.fromToken.symbol}</dd></div>
              <div><dt>Estimated paired asset</dt><dd>{formatUnits(BigInt(paymentQuote.expectedOut), paymentQuote.toToken.decimals)} {paymentQuote.toToken.symbol}</dd></div>
              <div><dt>Minimum paired asset</dt><dd>{formatUnits(BigInt(paymentQuote.minimumOut), paymentQuote.toToken.decimals)} {paymentQuote.toToken.symbol}</dd></div>
              <div><dt>LI.FI route fee</dt><dd>{formatUnits(BigInt(paymentQuote.feeAmount), paymentQuote.fromToken.decimals)} {paymentQuote.fromToken.symbol}{paymentQuote.feeUsd && ` (≈ $${paymentQuote.feeUsd})`}</dd></div>
              <div><dt>Estimated conversion gas</dt><dd>{paymentQuote.gasFeeUsd ? `≈ $${paymentQuote.gasFeeUsd}` : "Unavailable"}</dd></div>
              <div><dt>Recipient</dt><dd><code>{paymentQuote.account}</code></dd></div>
              <div><dt>Quote expires</dt><dd>{new Date(paymentQuote.expiresAt).toLocaleString("en-US")}</dd></div>
              <div><dt>First buy lock</dt><dd>{firstBuy.lockDays === 0 ? "No lock" : firstBuy.lockDays === 365 ? "1 year" : `${firstBuy.lockDays} days`}</dd></div>
            </dl><p>This payment supplies the first buy shown below, using the conversion's guaranteed output for its preview. Your token minimum stays fixed; after any necessary approvals and conversion, the final wallet transaction is prepared automatically. Network and route fees are included above.</p>
          </section>}
          {plan?.firstBuy && <section className="first-buy-preview" aria-label="First buy preview">
            <h3>Your first buy</h3>
            <dl className="review-facts">
              <div><dt>You spend</dt><dd>{plan.firstBuy.amount} {stock.symbol}</dd></div>
              <div><dt>Estimated tokens received</dt><dd><NumberText value={plan.firstBuy.expectedAmountOut} decimals={18} /> {draft.symbol}</dd></div>
              <div><dt>Minimum tokens received</dt><dd><NumberText value={plan.firstBuy.minAmountOut} decimals={18} /> {draft.symbol}</dd></div>
              <div><dt>Share of total supply</dt><dd>{formatUnits(BigInt(plan.firstBuy.expectedAmountOut) * 100_000_000n / SUPPLY, 6)}%</dd></div>
              <div><dt>Recipient</dt><dd><code>{plan.firstBuy.recipient}</code></dd></div>
              <div><dt>First buy lock</dt><dd>{(plan.firstBuy.lockDays ?? 0) === 0 ? "No lock" : plan.firstBuy.lockDays === 365 ? "1 year" : `${plan.firstBuy.lockDays} days`}</dd></div>
              <div><dt>Preview expires</dt><dd>{new Date(plan.firstBuy.deadline * 1000).toLocaleString("en-US")}</dd></div>
              <div><dt>Slippage tolerance</dt><dd>{plan.firstBuy.slippageBps / 100}%</dd></div>
              <div><dt>Approval amount</dt><dd>{plan.firstBuy.amount} {stock.symbol} only</dd></div>
            </dl>
            <p>The first buy waives the creator and platform portion of the trading fee. Protocol and liquidity fees are included; network gas is separate. Any required token approval happens first; the complete launch and buy is then simulated before wallet confirmation. If the buy fails, the launch also reverts. A confirmed approval remains in place.</p>
          </section>}
          <div className="review-progress">
            <span className="complete">
              <Check size={14} />
              Parameter check
            </span>
            <ChevronRight size={14} />
            <span className={plan ? "complete" : ""}>{Number(firstBuy.amount || "0") > 0 ? "First buy preview" : "On-chain simulation"}</span>
            <ChevronRight size={14} />
            <span>Wallet confirmation</span>
          </div>
          {(plan?.openingValuation && "warnings" in plan.openingValuation ? plan.openingValuation.warnings : undefined)?.map((warning) => <Notice key={warning.code}>{warning.message}</Notice>)}
          {paymentQuote?.warnings?.map((warning) => <Notice key={warning}>{warning}</Notice>)}
          {plan?.requiresReconfirmation && plan.firstBuy && <Notice>The updated minimum is {formatUnits(BigInt(plan.firstBuy.expectedAmountOut) * BigInt(10_000 - plan.firstBuy.slippageBps) / 10_000n, 18)} {draft.symbol || "tokens"}. Your previous payment and approval are saved.</Notice>}
          {error && <Notice kind="error">{error}</Notice>}
          {error && !busy && !paymentAttempt && !txHash && !submissionUnknown && /LI\.FI pricing or routing is unavailable|no.*route|liquidity|capacity is temporarily/i.test(error) && <div className="review-actions">
            <button type="button" className="secondary" onClick={() => void simulate()}>Retry preview</button>
            <button type="button" className="secondary" onClick={() => { setReview(false); requestAnimationFrame(() => document.querySelector<HTMLSelectElement>('select[aria-label="Pay with"]')?.focus()); }}>Choose another payment asset</button>
            <button type="button" className="secondary" onClick={() => updateFirstBuy({ ...firstBuy, payAddress: stock.address, amount: "0", lockDays: 0 })}>Use existing {stock.symbol}</button>
            <button type="button" className="secondary" onClick={() => updateFirstBuy({ ...firstBuy, amount: "0", lockDays: 0 })}>Launch without a first buy</button>
          </div>}
          {message && !planExpired && <Notice kind="success">{message}</Notice>}
          {plan && !planExpired && (
            <p className="launch-caption">
              Set using LI.FI buy/sell quotes at preview time. A fresh reference is used when this plan is prepared. You have five minutes to confirm in your wallet. The optional first buy moves the pool price above its initial target.
            </p>
          )}
          {planExpired && !busy && (
            <Notice>This preview has expired. Continuing refreshes it automatically; your inputs, payment and approvals are saved.</Notice>
          )}
          {wallet.error && <Notice kind="error">{wallet.error}</Notice>}
          {wallet.account && wallet.chainId !== config.chainId && <button className="secondary full" disabled={busy}
            onClick={() => void wallet.switchChain(config.chainId)}>Switch wallet to {chainName}</button>}
          {!wallet.account ? (
            <button
              className="primary full"
              disabled={wallet.connecting}
              onClick={() => void wallet.connect()}
            >
              {wallet.connecting ? "Connecting…" : "Connect wallet to continue"}
              <Wallet size={16} />
            </button>
          ) : paymentAttempt && !paymentAttempt.actualOutput ? (
            <button className="primary full" disabled={busy} onClick={() => void recoverPayment()}>Check submitted payment</button>
          ) : plan?.requiresReconfirmation ? (
            <button className="primary full" disabled={busy} onClick={() => void acceptPriceChange()}>{converting && !converted ? "Accept updated minimum and convert" : "Accept updated minimum"}</button>
          ) : paymentQuote && plan ? (
            <button className="primary full" disabled={busy || !config.writesEnabled || wallet.chainId !== config.chainId}
              onClick={() => void convertPayment()}>{busy ? "Confirming payment…" : paymentQuote.protocol === "wrap" ? "Wrap ETH and launch" : "Convert payment and launch"}<ArrowRight size={17} /></button>
          ) : converting && !converted ? (
            <button className="primary full" disabled={busy} onClick={() => void simulate()}>Refresh payment and launch preview<RefreshCw size={17} /></button>
          ) : !plan ? (
            <button
              className="primary full"
              disabled={busy || !!txHash || !config?.treasury}
              onClick={() => void simulate()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}
              {busy ? "Preparing launch preview…" : planExpired ? "Refresh preview" : Number(firstBuy.amount || "0") > 0 ? "Preview launch and first buy" : "Simulate launch"}
            </button>
          ) : (
            <>
              <div className="plan-result">
                <CheckCircle2 size={16} />
                <span>
                  {plan.firstBuy ? "First buy quoted" : "Simulation passed"} · Predicted token address
                  <br />
                  <code>{plan.tokenAddress}</code>
                </span>
              </div>
              <button
                className="primary full"
                disabled={busy || !!txHash || !config?.writesEnabled || wallet.chainId !== config.chainId}
                onClick={() => void launch()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Rocket size={17} />
                )}
                {busy ? "Waiting for confirmation…" : plan.firstBuy ? "Confirm launch and first buy" : "Confirm launch · Sign in wallet"}
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
  const api = scopedApi(config);
  const generation = useRef(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const resource = useResource<{
      token: TokenRecord;
      state: { poolKey: V4PoolKey } | null;
      stateError?: string;
      stateInvalid?: true;
    }>(`/tokens/${address}`, detailRevision),
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
    [clock, setClock] = useState(quoteNow());
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
    setClock(quoteNow(quote ?? undefined));
    const timer = setInterval(() => setClock(quoteNow(quote ?? undefined)), 1000);
    return () => clearInterval(timer);
  }, [quote]);
  // Depend on the asset, not the response object, so a background detail
  // refresh does not blank and re-read the wallet balance.
  const balanceAsset = resource.data ? (side === "buy" ? resource.data.token.quoteAddress : resource.data.token.address) : null;
  useEffect(() => {
    let active = true;
    setBalance(null);
    if (wallet.account && balanceAsset)
      wallet
        .balance(balanceAsset)
        .then((x) => {
          if (active) setBalance(x);
        })
        .catch((e) => {
          if (active) setError(`Could not load balance: ${errorMessage(e)}`);
        });
    return () => {
      active = false;
    };
  }, [wallet.account, wallet.revision, balanceAsset, hash]);
  // Metadata stays readable while the pool state is unavailable; retry the
  // state quietly so trading resumes without a manual reload. A pool that
  // contradicts the listing is not transient and is not retried.
  const stateUnavailable = !!resource.data && !resource.data.state;
  const stateInvalid = !!resource.data?.stateInvalid;
  // Keep the last lookup error on screen while a retry is in flight.
  const [lastLookupError, setLastLookupError] = useState({ address, message: "" });
  useEffect(() => {
    if (resource.error) setLastLookupError({ address, message: resource.error });
    else if (resource.data && !resource.loading) setLastLookupError({ address, message: "" });
  }, [address, resource.error, resource.data, resource.loading]);
  const lastError = lastLookupError.address === address ? lastLookupError.message : "";
  useEffect(() => {
    if (stateInvalid || (!stateUnavailable && !(lastError && !resource.data))) return;
    const timer = setTimeout(() => setDetailRevision((value) => value + 1), 15_000);
    return () => clearTimeout(timer);
  }, [stateUnavailable, stateInvalid, lastError, resource.data]);
  const token = resource.data?.token;
  if (!token) {
    const lookupError = resource.error || lastError;
    if (!lookupError) return <Loading />;
    // A catalog miss is never proof a launch does not exist: a launch this
    // browser sent may still be awaiting registration from Your transactions.
    const pendingRegistration = !!config && sentLaunchAwaitingRegistration(config, address);
    return pendingRegistration ? (
      <Notice>
        This launch is not registered yet. Finish registration from Your transactions.
        {" "}({lookupError})
      </Notice>
    ) : <Notice kind="error">{lookupError}</Notice>;
  }
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
          <FirstBuyLock token={token} config={config} />
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
            <FeeBreakdown policy={token.feePolicy} tradingFeeBps={token.tradingFeeBps}>
              <Link href="/buyback" className="mechanism-link">View the buyback policy and status <ArrowUpRight size={14} /></Link>
            </FeeBreakdown>
            <details className="launch-curve-details">
              <summary>View launch curve</summary>
              <LaunchCurve ticker={stock.symbol} curvePolicy={token.curvePolicy}
                openingValuation={token.openingValuation} quoteDecimals={stock.decimals}
                tokenAddress={token.address} quoteAddress={stock.address} />
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
          {stateInvalid ? (
            <Notice kind="error">The on-chain pool does not match this listing, so quotes and trades are disabled.</Notice>
          ) : stateUnavailable && (
            <Notice kind="error">
              On-chain pool state is unavailable, so quotes and trades are paused. Retrying automatically.
              {resource.data?.stateError ? ` ${resource.data.stateError}` : ""}
            </Notice>
          )}
          {resource.error && <Notice kind="error">Could not refresh this token: {resource.error}</Notice>}
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
            disabled={busy || !amount || stateUnavailable}
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
    engine: token.feeEngine,
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
  const api = scopedApi(config);
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
  hasMore,
  loading,
  loadMore,
}: {
  tokens: TokenRecord[];
  config: RuntimeConfig | null;
  hasMore: boolean;
  loading: boolean;
  loadMore: () => void;
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
          <h3>{hasMore ? "No matching launches in the loaded page" : "No launches for this wallet yet"}</h3>
          <p>{hasMore ? "Load older launches to find this wallet's fees." : "Launch a token with this wallet to manage its fees here."}</p>
          <Link href="/create" className="primary">
            Launch your first token
            <Plus size={16} />
          </Link>
        </div>
      )}
      {wallet.account && hasMore && <button type="button" className="secondary full" disabled={loading} onClick={loadMore}>{loading ? "Loading older launches…" : "Load older launches"}</button>}
      <div className="panel">
        <h2>How are fees distributed for new pools?</h2>
        <FeeBreakdown policy={launchFeePolicy(config)}>
          <Link href="/buyback" className="mechanism-link">View the buyback policy and status <ArrowUpRight size={14} /></Link>
        </FeeBreakdown>
      </div>
    </>
  );
}
