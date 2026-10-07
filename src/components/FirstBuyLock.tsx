import { useEffect, useRef, useState } from "react";
import { formatUnits, type Address, type Hash } from "viem";
import { chainApi } from "../lib/api";
import { deploymentChain, explorerFor, ROBINHOOD_BUNDLER, sameAddress, shortAddress, type RuntimeConfig, type TokenRecord } from "../lib/config";
import type { FirstBuyLockStatus } from "../lib/launch-plan";
import { errorMessage } from "../lib/validation";
import { useWallet } from "../lib/wallet";
import { isUnresolvedFirstBuyClaim, transactions, type Transaction } from "../lib/transactions";

type Props = { token?: TokenRecord; tokenAddress?: Address; deploymentChainId?: 8453 | 4663; config: RuntimeConfig | null };
export default function FirstBuyLock(props: Props) {
  const address = props.token?.address ?? props.tokenAddress;
  if (!address) return null;
  const chain = props.token?.deploymentChainId ?? (props.token?.mode === "robinhood" ? 4663 : props.deploymentChainId ?? deploymentChain(props.config ?? undefined));
  return <LockPosition key={`${chain}:${address}`} {...props} address={address} chain={chain} />;
}
function LockPosition({ token, address, chain, config }: Props & { address: Address; chain: 8453 | 4663 }) {
  const wallet = useWallet(), record = token?.firstBuyLock;
  const [status, setStatus] = useState<FirstBuyLockStatus | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [hash, setHash] = useState<Hash | null>(null);
  const [refresh, setRefresh] = useState(0), [pendingClaim, setPendingClaim] = useState<Transaction | null>(null);
  const actions = useRef(0);
  useEffect(() => { actions.current++; setBusy(false); setHash(null); return () => { actions.current++; }; }, [wallet.revision, config?.chainId]);
  useEffect(() => {
    let active = true, loading = false;
    const read = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await chainApi<FirstBuyLockStatus | null>(chain, `/first-buy-lock/${address}`);
        if (next && (!sameAddress(next.bundler, ROBINHOOD_BUNDLER) || next.tokenAddress && !sameAddress(next.tokenAddress, address) ||
          next.deploymentChainId && next.deploymentChainId !== chain || next.unlockAt !== next.start + next.vestingDuration ||
          BigInt(next.claimedAmount) < 0n || BigInt(next.claimableAmount) < 0n ||
          BigInt(next.claimedAmount) + BigInt(next.claimableAmount) > BigInt(next.totalAmount)))
          throw new Error("The on-chain lock identity could not be verified.");
        if (active) { setStatus(next); setError(""); setLoaded(true); }
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { loading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 20_000);
    return () => { active = false; clearInterval(timer); };
  }, [address, chain, record, refresh, hash]);
  const position = status ?? record;
  useEffect(() => {
    if (!config || !position) return;
    const sync = () => setPendingClaim(transactions().find((row) => isUnresolvedFirstBuyClaim(row, address, position.recipient, config)) ?? null);
    sync(); window.addEventListener("musegod:transactions", sync); window.addEventListener("storage", sync);
    return () => { window.removeEventListener("musegod:transactions", sync); window.removeEventListener("storage", sync); };
  }, [address, position?.recipient, config?.chainId, config?.deploymentChainId, config?.mode]);
  const canClaim = !!status && BigInt(status.claimableAmount) > 0n && !!wallet.account && sameAddress(wallet.account, status.recipient) &&
    !!config?.writesEnabled && deploymentChain(config) === chain && wallet.chainId === config.chainId && !pendingClaim;
  async function claim() {
    if (!config || !canClaim || busy) return;
    const request = ++actions.current; setBusy(true); setError("");
    try {
      const mined = await wallet.claimFirstBuy(address, config, (submitted) => request === actions.current && setHash(submitted));
      if (request === actions.current) { setHash(mined); setRefresh((value) => value + 1); }
    } catch (cause) { if (request === actions.current) setError(errorMessage(cause)); }
    finally { if (request === actions.current) setBusy(false); }
  }
  const amount = (value: string) => status?.decimals !== undefined || token
    ? `${formatUnits(BigInt(value), status?.decimals ?? 18)} ${status?.symbol ?? token?.symbol ?? "tokens"}` : `${value} raw token units`;
  const explorer = explorerFor({ mode: config?.mode === "fork" ? "fork" : chain === 4663 ? "robinhood" : "base", deploymentChainId: chain });
  const titleId = `lock-${chain}-${address}`;
  return <section className="panel first-buy-lock-details" aria-labelledby={titleId}>
    <div className="section-heading"><h2 id={titleId}>Your locked first buy</h2>{position && <span className="pill">{position.lockDays} days</span>}</div>
    <p><code className="wrap">{address}</code></p>
    {position ? <dl className="review-facts">
      <div><dt>Locked purchase</dt><dd>{amount(position.totalAmount)}</dd></div>
      <div><dt>Recipient</dt><dd><code className="wrap">{position.recipient}</code></dd></div>
      <div><dt>Unlock time</dt><dd>{new Date((position.start + position.vestingDuration) * 1000).toLocaleString("en-US")}</dd></div>
      <div><dt>Claimed</dt><dd>{status ? amount(status.claimedAmount) : "Reading on-chain status…"}</dd></div>
      <div><dt>Currently claimable</dt><dd aria-live="polite">{status ? amount(status.claimableAmount) : "Reading on-chain status…"}</dd></div>
    </dl> : <p role="status">{loaded ? "No locked purchase was found for this token." : "Reading on-chain lock status…"}</p>}
    <p className="muted">Your lock and claim remain available even while the launch is syncing to the catalog.</p>
    {canClaim && <button className="primary full" disabled={busy} onClick={() => void claim()}>{busy ? "Waiting for claim confirmation…" : "Claim unlocked tokens"}</button>}
    {pendingClaim && <p role="status">Your claim is being checked in transaction history.</p>}
    {hash && <p>{explorer && token?.mode !== "fork" ? <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{shortAddress(hash)}</a> : <code className="wrap">{hash}</code>}</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="secondary" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Refresh lock status</button>
  </section>;
}
