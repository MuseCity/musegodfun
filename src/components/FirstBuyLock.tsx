import { useEffect, useRef, useState } from "react";
import { formatUnits, type Hash } from "viem";
import { chainApi } from "../lib/api";
import { deploymentChain, explorerFor, sameAddress, shortAddress, type RuntimeConfig, type TokenRecord } from "../lib/config";
import type { FirstBuyLockStatus } from "../lib/launch-plan";
import { errorMessage } from "../lib/validation";
import { useWallet } from "../lib/wallet";
import { isUnresolvedFirstBuyClaim, transactions, type Transaction } from "../lib/transactions";

export default function FirstBuyLock({ token, config }: { token: TokenRecord; config: RuntimeConfig | null }) {
  const wallet = useWallet(), record = token.firstBuyLock;
  const tokenChain = token.deploymentChainId ?? (token.mode === "robinhood" ? 4663 : 8453);
  const [status, setStatus] = useState<FirstBuyLockStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<Hash | null>(null);
  const [confirmedHash, setConfirmedHash] = useState<Hash | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pendingClaim, setPendingClaim] = useState<Transaction | null>(null);
  const actions = useRef(0);

  useEffect(() => {
    actions.current++;
    setHash(null); setConfirmedHash(null); setBusy(false); setError(""); setStatus(null);
    return () => { actions.current++; };
  }, [token.address, tokenChain, config?.chainId, config?.deploymentChainId, config?.mode, wallet.revision]);

  useEffect(() => {
    if (!record || !config) { setPendingClaim(null); return; }
    const sync = () => {
      const rows = transactions();
      setPendingClaim(rows.find((row) => isUnresolvedFirstBuyClaim(row, token.address, record.recipient, config)) ?? null);
    };
    sync();
    window.addEventListener("musegod:transactions", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("musegod:transactions", sync); window.removeEventListener("storage", sync); };
  }, [token.address, tokenChain, record?.recipient, config?.chainId, config?.deploymentChainId, config?.mode, wallet.revision]);

  useEffect(() => {
    if (!record) return;
    let active = true, loading = false;
    setStatus(null);
    const read = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await chainApi<FirstBuyLockStatus | null>(tokenChain, `/first-buy-lock/${token.address}`);
        if (!next || !sameAddress(next.bundler, record.bundler) || !sameAddress(next.recipient, record.recipient) ||
          next.totalAmount !== record.totalAmount || next.start !== record.start || next.cliffDuration !== record.cliffDuration ||
          next.vestingDuration !== record.vestingDuration || next.unlockAt !== record.start + record.vestingDuration ||
          BigInt(next.claimedAmount) < 0n || BigInt(next.claimableAmount) < 0n ||
          BigInt(next.claimedAmount) + BigInt(next.claimableAmount) > BigInt(record.totalAmount))
          throw new Error("The on-chain lock read does not match this token's verified position.");
        if (active) { setStatus(next); setError(""); }
      } catch (cause) {
        if (active) { setStatus(null); setError(`On-chain lock status is unavailable. ${errorMessage(cause)}`); }
      } finally { loading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 20_000);
    return () => { active = false; clearInterval(timer); };
  }, [token.address, tokenChain, record?.bundler, record?.recipient, record?.totalAmount, record?.start,
    record?.cliffDuration, record?.vestingDuration, wallet.revision, hash, confirmedHash, refresh]);

  if (!record) return null;
  const isRecipient = !!wallet.account && sameAddress(wallet.account, record.recipient);
  const hasClaimable = !!status && BigInt(status.claimableAmount) > 0n;
  const canClaim = isRecipient && hasClaimable && !!config?.writesEnabled && wallet.chainId === config.chainId &&
    deploymentChain(config) === tokenChain && !pendingClaim;
  const fullyClaimed = !!status && BigInt(status.claimedAmount) === BigInt(record.totalAmount);
  const label = !status ? error ? "Unavailable" : "Reading on-chain status…"
    : fullyClaimed ? "Claimed" : hasClaimable ? "Ready to claim" : "No tokens currently claimable";
  const amount = (raw: string) => formatUnits(BigInt(raw), 18);
  const explorer = explorerFor({ mode: tokenChain === 4663 ? "robinhood" : "base" });

  async function claim() {
    if (!config || !canClaim || busy) return;
    const request = ++actions.current;
    setBusy(true); setError(""); setConfirmedHash(null);
    try {
      const mined = await wallet.claimFirstBuy(token.address, config, (submitted) => {
        if (request === actions.current) setHash(submitted);
      });
      if (request === actions.current) { setConfirmedHash(mined); setHash(mined); setRefresh((value) => value + 1); }
    } catch (cause) {
      if (request === actions.current) setError(errorMessage(cause));
    } finally { if (request === actions.current) setBusy(false); }
  }

  return <section className="panel first-buy-lock-details" aria-labelledby="first-buy-lock-title">
    <div className="section-heading"><h2 id="first-buy-lock-title">Your locked first buy</h2><span className="pill">{record.lockDays} days</span></div>
    <dl className="review-facts">
      <div><dt>Locked purchase</dt><dd>{amount(record.totalAmount)} {token.symbol}</dd></div>
      <div><dt>Recipient</dt><dd><code className="wrap">{record.recipient}</code></dd></div>
      <div><dt>Unlock time</dt><dd>{new Date((record.start + record.vestingDuration) * 1000).toLocaleString("en-US")}</dd></div>
      <div><dt>On-chain status</dt><dd aria-live="polite">{label}</dd></div>
      <div><dt>Claimed</dt><dd>{status ? `${amount(status.claimedAmount)} ${token.symbol}` : "Unavailable"}</dd></div>
      <div><dt>Currently claimable</dt><dd>{status ? `${amount(status.claimableAmount)} ${token.symbol}` : "Unavailable"}</dd></div>
    </dl>
    <p className="muted">The full purchase stays in the on-chain Bundler until its lock ends. Only the recorded recipient can claim it.</p>
    {canClaim && <button className="primary full" disabled={busy} onClick={() => void claim()}>{busy ? "Waiting for claim confirmation…" : "Claim unlocked tokens"}</button>}
    {confirmedHash && <p role="status">{fullyClaimed ? "The claim is confirmed and the on-chain position is fully claimed."
      : "Claim transaction confirmed. Waiting for on-chain state verification."}</p>}
    {pendingClaim && <p role="status">A claim is pending. Check its saved transaction status before submitting another claim.</p>}
    {hash && <p className="muted">Claim transaction: {token.mode === "fork" ? <code className="wrap">{hash}</code>
      : <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{shortAddress(hash)}</a>}</p>}
    {error && <p role="alert">{error}</p>}
    {!status && <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh lock status</button>}
  </section>;
}
