import { useEffect, useState } from "react";
import { ArrowRight, Gem, LockKeyhole, RefreshCw, TriangleAlert, Vault } from "lucide-react";
import { formatUnits, zeroAddress, type Address, type Hex } from "viem";
import { chainApi } from "../lib/api";
import { deploymentChain, explorerFor, networkName, sameAddress, shortAddress, stockByAddress, type RuntimeConfig, type TokenRecord } from "../lib/config";
import { isMuse, nftKey, treasuryFor, vaultFor, type NftRef, type NftStatus } from "../lib/nft-mode";
import { readNftStatus } from "../lib/nft-client";
import { LOCK_PRESET_DAYS, activateTreasuryTxs, depositTx, deployVaultTx, lockTarget, lockTx, readTreasuryLock, sweepTx, withdrawTx } from "../lib/nft-treasury";
import { nftPath } from "../lib/network";
import { errorMessage, parseAmount } from "../lib/validation";
import { transactionClient, useWallet } from "../lib/wallet";
import { NftBadge } from "./TokenCard";

type FeePair = { fees0: string; fees1: string };
type PendingFee = { token: Address; lp: FeePair; trade: FeePair; poolKey: { currency0: Address; currency1: Address } } | { token: Address; error: string };
/** `/nft-treasury`: the vault and treasury, what the treasury (`amount`) and vault hold of the bound coins and their pairs, and each coin's
 * fees still waiting in Doppler for the vault. */
type NftTreasuryView = { nft: NftRef; vault: Address; vaultDeployed: boolean; treasury: Address; treasuryDeployed: boolean;
  balances: { token: Address; symbol: string; amount: string; vaultAmount: string | null }[]; pendingFees: PendingFee[] };
type Tx = { to: Address; data: Hex };

const MUSE_SITE = "https://musegod.org/muse";
const HOLDER_ONLY = "Only the NFT holder can withdraw or lock the treasury.";
const OWNERSHIP_CYCLE = "Do not send this NFT to its own treasury: it would be locked forever.";
const LOCK_COPY = "Locking stops withdrawals until the date; use it when listing the NFT for sale.";

export function nftQuery(nft: NftRef) {
  return encodeURIComponent(`${nft.chainId}:${nft.contract}:${nft.tokenId}`);
}
/** A coin, a pair asset, or an address without a known symbol (shown as 18 decimals). */
function assetOf(token: Address, coins: TokenRecord[]) {
  const coin = coins.find((entry) => sameAddress(entry.address, token));
  if (coin) return { symbol: coin.symbol, decimals: 18 };
  try { const stock = stockByAddress(token); return { symbol: stock.symbol, decimals: stock.decimals }; }
  catch { return { symbol: shortAddress(token), decimals: 18 }; }
}
function amountText(raw: bigint | string, decimals: number) {
  const value = BigInt(raw);
  if (value === 0n) return "0";
  const amount = Number(formatUnits(value, decimals));
  return amount < 0.000001 ? "< 0.000001" : amount.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
const dateText = (seconds: number) => new Date(seconds * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

function AddressLink({ address, config }: { address: Address; config: RuntimeConfig }) {
  const explorer = explorerFor(config);
  return explorer ? <a className="mono" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" title={address}>{shortAddress(address)} ↗</a>
    : <code title={address}>{shortAddress(address)}</code>;
}

/** The bound NFT, its fee vault and Tokenbound treasury, and the treasury actions. `coin`: the token page's coin (its verification and
 * hidden state); `coins`: the coins whose fees the sweep claims. */
export function NftTreasuryCard({ config, nft, coins, coin, navigate }: {
  config: RuntimeConfig; nft: NftRef; coins: TokenRecord[]; coin?: TokenRecord; navigate?: (path: string) => void;
}) {
  const wallet = useWallet(), account = wallet.account;
  const factory = config.nftMode?.vaultFactory ?? null, treasury = treasuryFor(nft), vault = factory ? vaultFor(nft, factory) : null;
  const key = nftKey(nft), muse = isMuse(nft);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<NftTreasuryView | null>(null), [viewError, setViewError] = useState("");
  const [status, setStatus] = useState<NftStatus | null>(null), [statusError, setStatusError] = useState("");
  const [lock, setLock] = useState<{ lockedUntil: number; locked: boolean } | null>(null), [lockError, setLockError] = useState("");
  const [busy, setBusy] = useState(""), [progress, setProgress] = useState(""), [error, setError] = useState("");
  const [hash, setHash] = useState<Hex | null>(null);
  // Code seen on-chain after a confirmed action: the server keeps a clean treasury view for 15 s, so Deploy and Activate never reappear.
  const [onChain, setOnChain] = useState({ vault: false, treasury: false });
  const [withdrawAmounts, setWithdrawAmounts] = useState<Record<string, string>>({});
  const assets = [...new Map(coins.flatMap((entry) => [entry.address, entry.quoteAddress]).map((token) => [token.toLowerCase(), token])).values()];
  const [depositChoice, setDepositChoice] = useState(""), [depositAmount, setDepositAmount] = useState("");
  // The NFT page's coins arrive after the first render, so the chosen asset falls back to the first one listed.
  const depositToken = (depositChoice && assets.find((token) => sameAddress(token, depositChoice))) || assets[0];

  // Once per page view, on Refresh and after a confirmed action; never without a verified factory (the server has no vault to report).
  useEffect(() => {
    let active = true;
    setViewError("");
    if (!factory) { setView(null); return; }
    chainApi<NftTreasuryView>(deploymentChain(config), `/nft-treasury?nft=${nftQuery(nft)}`)
      .then((next) => { if (active) { setView(next); setWithdrawAmounts({}); } }, (cause) => { if (active) setViewError(errorMessage(cause)); });
    return () => { active = false; };
  }, [key, factory, revision]);
  useEffect(() => {
    let active = true;
    setStatusError("");
    readNftStatus(config, nft, account ?? zeroAddress)
      .then((next) => { if (active) setStatus(next); }, (cause) => { if (active) setStatusError(errorMessage(cause)); });
    return () => { active = false; };
  }, [key, account, revision]);
  const vaultDeployed = !!view?.vaultDeployed || onChain.vault, deployed = !!view?.treasuryDeployed || onChain.treasury;
  useEffect(() => {
    let active = true;
    setLock(null); setLockError("");
    if (!deployed) return;
    readTreasuryLock(transactionClient(config.chainId, config), nft)
      .then((next) => { if (active) setLock(next); }, (cause) => { if (active) setLockError(errorMessage(cause)); });
    return () => { active = false; };
  }, [key, deployed, revision]);

  const owner = !!account && !!status?.owner && sameAddress(status.owner, account);
  // Tokens sent to the treasury of a burned token or a non-ERC-721 could never be withdrawn.
  const usable = !!status?.erc721 && !!status.owner, holderless = !!status && !usable;
  // Withdraw and Lock wait for a successful lock read.
  const locked = !!lock?.locked, lockKnown = lock !== null;
  const signBlock = !account ? "" : !config.writesEnabled ? config.blockReason || "Transactions are currently disabled."
    : wallet.chainId !== config.chainId ? `Switch your wallet to ${networkName(config)} to use these actions.` : "";
  const canSign = !!account && !signBlock && !busy;
  const retry = () => setRevision((n) => n + 1);
  async function run(label: string, build: () => Promise<Tx[]> | Tx[]) {
    setBusy(label); setError(""); setHash(null);
    try {
      const steps = await build();
      for (const [index, step] of steps.entries()) {
        setProgress(steps.length > 1 ? `${label}: step ${index + 1} of ${steps.length}. Confirm it in your wallet.` : `${label}: confirm it in your wallet.`);
        setHash(await wallet.send(step.to, step.data, config, (submitted) => {
          setHash(submitted); setProgress(`${label}: waiting for on-chain confirmation.`);
        }, { nft }));
      }
      setProgress(`${label}: confirmed.`);
      try {
        const client = transactionClient(config.chainId, config);
        const [vaultCode, treasuryCode] = await Promise.all([vault ? client.getCode({ address: vault }) : undefined, client.getCode({ address: treasury })]);
        const hasCode = (code: Hex | undefined) => !!code && code !== "0x";
        setOnChain((current) => ({ vault: current.vault || hasCode(vaultCode), treasury: current.treasury || hasCode(treasuryCode) }));
      } catch { /* The next refresh reports the deployment. */ }
      setRevision((n) => n + 1);
    } catch (cause) {
      setError(errorMessage(cause)); setProgress("");
    } finally { setBusy(""); }
  }
  const sweep = () => run("Sweep fees", () => [...(vaultDeployed ? [] : [deployVaultTx(factory!, nft)]),
    sweepTx(vault!, coins.map((entry) => entry.poolId), assets)]);
  const lockFor = (days: number) => run("Lock treasury", async () => {
    const block = await transactionClient(config.chainId, config).getBlock();
    return [lockTx(nft, lockTarget(block.timestamp, days))];
  });

  const verified = muse || (config.nftMode?.verifiedCollections ?? []).includes(`${nft.chainId}:${nft.contract.toLowerCase()}`);
  const explorer = explorerFor(config);
  const pending = (view?.pendingFees ?? []).flatMap((entry) => {
    const coinOf = assetOf(entry.token, coins);
    if ("error" in entry) return [{ key: entry.token, label: `${coinOf.symbol} pool`, text: "Fee preview unavailable" }];
    return ([["currency0", "fees0"], ["currency1", "fees1"]] as const).map(([currency, field]) => {
      const asset = assetOf(entry.poolKey[currency], coins);
      return { key: `${entry.token}:${currency}`, label: `${coinOf.symbol} pool · ${asset.symbol}`, text: amountText(BigInt(entry.trade[field]) + BigInt(entry.lp[field]), asset.decimals) };
    });
  });
  const lockText = !deployed ? "Not active yet" : lockError ? "Unavailable" : !lock ? "Reading…" : locked ? `Locked until ${dateText(lock.lockedUntil)}` : "Unlocked";
  return (
    <section className="card nft-card" id="nft-card" aria-labelledby={`nft-card-${key}`}>
      <div className="card-head">
        <h2 id={`nft-card-${key}`} className="card-title"><Gem size={18} aria-hidden="true" />{muse ? `Muse #${nft.tokenId}` : `NFT #${nft.tokenId}`}</h2>
        <span className="button-row">
          {coin && <NftBadge token={coin} />}
          <button type="button" className="text-button" disabled={!!busy} onClick={() => setRevision((n) => n + 1)}><RefreshCw size={14} aria-hidden="true" />Refresh</button>
        </span>
      </div>
      {coin?.hidden && <p className="nft-warning nft-banner" role="note">Hidden by operator. This coin is not listed on Explore; trading, sweeping and the treasury still work.</p>}
      <div className="nft-identity">
        {muse && <a className="nft-art" href={`${MUSE_SITE}/${nft.tokenId}`} target="_blank" rel="noreferrer">
          <img src={`${MUSE_SITE}/art/480/${nft.tokenId}.jpg`} alt={`Muse #${nft.tokenId}`} loading="lazy" referrerPolicy="no-referrer" width={96} height={96} /></a>}
        <dl className="rows">
          <div><dt>Bound NFT</dt><dd>{networkName(config)} · <span title={nft.contract}>{shortAddress(nft.contract)}</span> · {muse
            ? <a href={`${MUSE_SITE}/${nft.tokenId}`} target="_blank" rel="noreferrer">#{nft.tokenId} ↗</a> : `#${nft.tokenId}`}</dd></div>
          <div><dt>Collection</dt><dd className="sans">{verified ? "Verified collection" : <span className="nft-warning">Unverified collection</span>}</dd></div>
          {coin && <div><dt>Coin status</dt><dd className="sans">{coin.nftVerification?.status === "rejected"
            ? <span className="nft-warning">Rejected: {coin.nftVerification.reason || "no reason recorded"}</span>
            : coin.nftVerification?.status === "verified" ? "Verified" : "Unverified"}</dd></div>}
          {muse && status?.agentId && <div><dt>Agent</dt><dd className="sans">
            <a href={`${MUSE_SITE}/${nft.tokenId}.json`} target="_blank" rel="noreferrer">Agent #{status.agentId} (ERC-8004) ↗</a></dd></div>}
          <div><dt>Holder</dt><dd>{status?.owner ? <AddressLink address={status.owner} config={config} /> : statusError ? "Unavailable" : status ? "None" : "Reading…"}</dd></div>
          <div><dt>Fee vault</dt><dd>{vault ? <AddressLink address={vault} config={config} /> : "Not deployed"}</dd></div>
          <div><dt>Treasury</dt><dd><AddressLink address={treasury} config={config} /></dd></div>
          <div><dt>Treasury lock</dt><dd className="sans">{locked ? <span className="nft-warning">{lockText}</span> : lockText}</dd></div>
        </dl>
      </div>
      <p className="nft-warning">Creator fees go to this NFT's treasury, and whoever holds the NFT controls it. {OWNERSHIP_CYCLE}</p>
      {!factory && <p className="nft-warning" role="note">The fee vault is not deployed on this network yet.</p>}
      {holderless && <p className="nft-warning" role="note">This NFT has no holder, so its treasury cannot be used.</p>}
      {statusError && <div className="notice error" role="alert"><TriangleAlert size={17} aria-hidden="true" /><span>The NFT holder could not be read: {statusError}
        <button type="button" disabled={!!busy} onClick={retry}>Retry</button></span></div>}
      {viewError && <div className="notice error" role="alert"><TriangleAlert size={17} aria-hidden="true" /><span>Treasury balances could not be loaded: {viewError}</span></div>}
      {factory && <div className="nft-balances">
        <h3 className="nft-subtitle">Treasury balances</h3>
        {!view ? <p className="hint">{viewError ? "—" : "Reading…"}</p> : view.balances.length ? <dl className="rows boxed">
          {view.balances.map((row) => {
            const asset = assetOf(row.token, coins);
            return <div key={row.token}><dt>{row.symbol}</dt><dd>{amountText(row.amount, asset.decimals)}
              {row.vaultAmount && BigInt(row.vaultAmount) > 0n && <span className="hint"> · {amountText(row.vaultAmount, asset.decimals)} in the vault</span>}</dd></div>;
          })}
        </dl> : <p className="hint">No balances yet.</p>}
        {pending.length > 0 && <>
          <h3 className="nft-subtitle">Fees waiting to be swept</h3>
          <dl className="rows boxed">{pending.map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.text}</dd></div>)}</dl>
        </>}
      </div>}

      <div className="nft-actions">
        {!account && <button type="button" className="secondary" disabled={wallet.connecting} onClick={() => void wallet.connect()}>Connect wallet</button>}
        {signBlock && <p className="nft-warning" role="status">{signBlock}</p>}
        {factory && <div className="nft-action">
          <h3 className="nft-subtitle"><Vault size={15} aria-hidden="true" /> Sweep</h3>
          <p className="hint">Anyone can claim this NFT's creator fees into its treasury.{view && !vaultDeployed ? " The first sweep also deploys the fee vault." : ""}</p>
          <button type="button" className="primary" disabled={!canSign || !view || !coins.length} onClick={() => void sweep()}>Sweep fees to the treasury</button>
        </div>}
        {view && !deployed && usable && <div className="nft-action">
          <h3 className="nft-subtitle">Activate treasury</h3>
          <p className="hint">Creates the NFT's Tokenbound account so its holder can use it. Two wallet confirmations.</p>
          <button type="button" className="secondary" disabled={!canSign} onClick={() => void run("Activate treasury", () => activateTreasuryTxs(nft))}>Activate treasury</button>
        </div>}
        {deployed && <div className="nft-action">
          <h3 className="nft-subtitle"><LockKeyhole size={15} aria-hidden="true" /> Withdraw and lock</h3>
          {!owner ? (statusError ? null : <p className="nft-warning">{status ? HOLDER_ONLY : "Checking the NFT holder…"}</p>)
            : locked ? <p className="nft-warning">Locked until {dateText(lock!.lockedUntil)}. Withdraw and Lock open after that date.</p>
            : lockError ? <div className="notice error" role="alert"><TriangleAlert size={17} aria-hidden="true" /><span>The treasury lock could not be read, so Withdraw and
              Lock stay closed: {lockError} <button type="button" disabled={!!busy} onClick={retry}>Retry</button></span></div>
            : !lockKnown ? <p className="hint" role="status">Reading the treasury lock…</p> : null}
          {owner && view?.balances.filter((row) => BigInt(row.amount) > 0n).map((row) => {
            const asset = assetOf(row.token, coins), id = `withdraw-${key}-${row.token}`;
            const value = withdrawAmounts[row.token] ?? formatUnits(BigInt(row.amount), asset.decimals);
            return <div className="nft-row" key={row.token}>
              <label className="field" htmlFor={id}><span className="field-label">{row.symbol} amount to withdraw</span>
                <input id={id} className="input mono" inputMode="decimal" value={value} disabled={!!busy || locked || !lockKnown}
                  onChange={(event) => setWithdrawAmounts((current) => ({ ...current, [row.token]: event.target.value }))} /></label>
              <button type="button" className="secondary" aria-label={`Withdraw ${row.symbol}`} disabled={!canSign || locked || !lockKnown} onClick={() => void run(`Withdraw ${row.symbol}`, () =>
                [withdrawTx(nft, row.token, account!, parseAmount(value, asset.decimals))])}>Withdraw</button>
            </div>;
          })}
          {owner && <>
            <p className="nft-warning">{LOCK_COPY}</p>
            <div className="button-row" role="group" aria-label="Lock the treasury">
              {LOCK_PRESET_DAYS.map((days) => <button type="button" key={days} className="secondary" disabled={!canSign || locked || !lockKnown}
                onClick={() => void lockFor(days)}>Lock for {days} {days === 1 ? "day" : "days"}</button>)}
            </div>
          </>}
        </div>}
        {view && depositToken && usable && <div className="nft-action">
          <h3 className="nft-subtitle">Deposit to treasury</h3>
          <p className="hint">Any wallet can add tokens, for example to move a first buy into the NFT.</p>
          <p className="nft-warning">Only the NFT holder can withdraw deposits.</p>
          <div className="nft-row">
            <label className="field" htmlFor={`deposit-asset-${key}`}><span className="field-label">Deposit asset</span>
              <select id={`deposit-asset-${key}`} className="input" value={depositToken} disabled={!!busy} onChange={(event) => setDepositChoice(event.target.value)}>
                {assets.map((token) => <option key={token} value={token}>{assetOf(token, coins).symbol}</option>)}
              </select></label>
            <label className="field" htmlFor={`deposit-amount-${key}`}><span className="field-label">Deposit amount</span>
              <input id={`deposit-amount-${key}`} className="input mono" inputMode="decimal" placeholder="0.00" value={depositAmount} disabled={!!busy}
                onChange={(event) => setDepositAmount(event.target.value)} /></label>
            <button type="button" className="secondary" disabled={!canSign || !depositAmount} onClick={() => void run("Deposit", () =>
              [depositTx(nft, depositToken, parseAmount(depositAmount, assetOf(depositToken, coins).decimals))])}>Deposit</button>
          </div>
        </div>}
      </div>
      <p className="nft-progress" role="status" aria-live="polite">{progress}{hash && <> {explorer
        ? <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction</a> : <code className="wrap">{hash}</code>}</>}</p>
      {error && <div className="notice error" role="alert"><TriangleAlert size={17} aria-hidden="true" /><span>{error}</span></div>}
      {navigate && <a className="text-button" href={nftPath(nft)} onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); navigate(nftPath(nft)); }
      }}>Open the NFT page <ArrowRight size={14} aria-hidden="true" /></a>}
    </section>
  );
}

/** The token page's NFT card for a coin bound to an NFT. */
export default function NftCoinCard({ token, config, navigate }: { token: TokenRecord; config: RuntimeConfig | null; navigate: (path: string) => void }) {
  if (!token.nft || !config) return null;
  return <NftTreasuryCard config={config} nft={token.nft} coins={[token]} coin={token} navigate={navigate} />;
}
