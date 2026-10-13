import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { deploymentChain, explorerFor, type RuntimeConfig } from "../lib/config";
import { chainApi } from "../lib/api";
import { LAUNCH_FEE_STABLE } from "../lib/launch-fee";
import { withLaunchIntentLock } from "../lib/launch-intent";
import { MUSES, isMuse, nftKey, treasuryFor, type NftRef, type NftStatus } from "../lib/nft-mode";
import {
  launchFeeEthTx, launchFeeOf, launchFeeStableTx, launchFeeStorageKey, parseLaunchFeeRecord, readNftStatus, settleLaunchFee,
  type DraftLaunchFee, type LaunchFeeQuote, type LaunchFeeRecord,
} from "../lib/nft-client";
import { updateTransaction } from "../lib/transactions";
import { errorMessage, nftRefSchema, type LaunchInput } from "../lib/validation";
import { transactionClient, useWallet } from "../lib/wallet";

/** Element ids the create form uses to show why review waits and to move focus to the field to fix. */
export const NFT_STATUS_ID = "nft-launch-status", NFT_TOKEN_ID = "nft-launch-token", NFT_ERROR_ID = "nft-launch-error", NFT_FEE_ID = "nft-launch-fee";
export const NFT_DISCLAIMER = "Not investment advice. musegod.fun does not endorse NFT collections; an unverified collection may imitate another.";

export function LaunchModeSwitch({ nftMode, disabled, onChange }: { nftMode: boolean; disabled?: boolean; onChange: (nftMode: boolean) => void }) {
  return (
    <fieldset className="launch-mode" disabled={disabled}>
      <legend className="field-label">Launch type</legend>
      {([[false, "Normal"], [true, "NFT"]] as const).map(([value, label]) => <label key={label}>
        <input type="radio" name="launchMode" checked={nftMode === value} onChange={() => onChange(value)} />{label}
      </label>)}
    </fieldset>
  );
}

const readFee = (key: string) => { try { return parseLaunchFeeRecord(localStorage.getItem(key)); } catch { return null; } };
function writeFee(key: string, record: LaunchFeeRecord | null) {
  if (record) localStorage.setItem(key, JSON.stringify(record)); else localStorage.removeItem(key);
}
function TxHash({ hash, config }: { hash: Hex; config: RuntimeConfig }) {
  const explorer = explorerFor(config);
  return <><code className="wrap">{hash}</code>{explorer && <> <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction</a></>}</>;
}

/** Step one of an NFT launch: the NFT, its live check, and the $10 fee for a paid collection. `onChange` reports a confirmed NFT only,
 * and `undefined` while a check is pending or failed, so review can never proceed as a normal coin. */
export function NftLaunchStep({ config, account, draft, intentId, error = "", onChange, onFeePaid, onPrefill }: {
  config: RuntimeConfig; account: Address | null; draft: LaunchInput; intentId: string; error?: string;
  onChange: (nft: NftRef | undefined) => void; onFeePaid: (fee: DraftLaunchFee) => void; onPrefill?: (museName: string) => void;
}) {
  const nft = draft.nft, wallet = useWallet();
  const [contract, setContract] = useState<string>(nft?.contract ?? MUSES.contract);
  const [tokenId, setTokenId] = useState(nft?.tokenId ?? "");
  const [status, setStatus] = useState<NftStatus | null>(null);
  const [checkError, setCheckError] = useState("");
  // Parent callbacks are read through a ref, so a new callback identity never re-runs the check.
  const latest = useRef({ onChange, onFeePaid, onPrefill });
  latest.current = { onChange, onFeePaid, onPrefill };
  // The NFT the parent holds; a report that would not change it is skipped, so `undefined` is never sent twice in a row.
  const reported = useRef("");
  reported.current = nft ? nftKey(nft) : "";
  const report = (next?: NftRef) => {
    const key = next ? nftKey(next) : "";
    if (key === reported.current) return;
    reported.current = key;
    latest.current.onChange(next);
  };
  const prefilled = useRef("");
  const parsed = nftRefSchema.safeParse({ chainId: deploymentChain(config), contract, tokenId });
  const candidate = parsed.success ? parsed.data : null, candidateKey = candidate ? nftKey(candidate) : "";
  useEffect(() => {
    setStatus(null); setCheckError("");
    report(undefined);
    if (!account || !candidate) return;
    let active = true;
    const timer = setTimeout(() => {
      readNftStatus(config, candidate, account).then((result) => {
        if (!active) return;
        setStatus(result);
        if (!result.erc721 || !result.controls || result.alreadyLaunched) return;
        report(candidate);
        if (result.free && result.name && prefilled.current !== candidateKey) {
          prefilled.current = candidateKey;
          latest.current.onPrefill?.(result.name);
        }
      }, (cause: unknown) => { if (active) setCheckError(errorMessage(cause)); });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [candidateKey, account, config.chainId, config.deploymentChainId]);

  const statusText = !account ? "Connect the wallet that holds the NFT."
    : tokenId && !parsed.success ? parsed.error.issues[0]?.message ?? "Check the contract and token number."
    : !candidate ? "Enter the token number to check it."
    : checkError ? checkError
    : !status ? "Checking this NFT…"
    : !status.erc721 ? "This contract is not an ERC-721 collection."
    : !status.controls ? "This wallet does not hold the NFT and has no delegation for it."
    : status.alreadyLaunched ? "This NFT already has its coin."
    : status.free ? "Muse launches are free. Muse coins pair with MUSEGOD."
    : "Launching for this NFT costs $10, paid before the launch.";

  // ---- the $10 fee: saved with its hash when sent, attached to the draft only after two confirmations ----
  const feeKey = account ? launchFeeStorageKey(config, account, intentId) : "";
  const currentKey = useRef(feeKey);
  currentKey.current = feeKey;
  const [pendingFee, setPendingFee] = useState<LaunchFeeRecord | null>(null);
  const [paying, setPaying] = useState(false), [checking, setChecking] = useState(false), [payError, setPayError] = useState("");
  // The hash this form is already waiting for, through the wallet or a receipt check.
  const watching = useRef("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const visible = (key: string) => alive.current && key === currentKey.current;
  function paid(key: string, fee: DraftLaunchFee) {
    writeFee(key, fee);
    if (visible(key)) { setPendingFee(null); latest.current.onFeePaid(fee); }
  }
  async function settle(key: string, record: LaunchFeeRecord) {
    if (watching.current === record.txHash) return;
    watching.current = record.txHash;
    if (visible(key)) { setChecking(true); setPayError(""); }
    try {
      const outcome = await settleLaunchFee(transactionClient(config.chainId, config), record);
      const saved = readFee(key);
      if (!saved?.pending || saved.txHash !== record.txHash) {
        // Another tab settled or replaced it first: show what it saved.
        if (visible(key)) { setPendingFee(saved?.pending ? saved : null); if (saved && !saved.pending) latest.current.onFeePaid(saved); }
        return;
      }
      if (outcome.status === "paid") {
        // A reload ended the wallet's own wait, so its history row is settled here.
        if (outcome.fee.txHash === record.txHash) updateTransaction(record.txHash, config.chainId, { status: "success" }, config.deploymentChainId);
        paid(key, outcome.fee);
      }
      else {
        writeFee(key, null);
        if (visible(key)) { setPendingFee(null); setPayError(outcome.reason); }
      }
    } catch {
      if (visible(key)) setPayError("The payment is still confirming. Check it again in a moment. It will not be sent twice.");
    } finally {
      watching.current = "";
      if (visible(key)) setChecking(false);
    }
  }
  const hasFee = !!draft.launchFee;
  useEffect(() => {
    if (!feeKey) { setPendingFee(null); return; }
    const saved = readFee(feeKey);
    setPendingFee(saved?.pending ? saved : null);
    if (!saved) return;
    if (!saved.pending) { if (!hasFee) latest.current.onFeePaid(saved); return; }
    void settle(feeKey, saved);
  }, [feeKey, hasFee]);
  async function pay(asset: DraftLaunchFee["asset"]) {
    if (!account || !feeKey || paying) return;
    const key = feeKey;
    let sent = null as LaunchFeeRecord | null; // Set when the wallet returns the hash.
    setPaying(true); setPayError("");
    try {
      await withLaunchIntentLock(config, account, intentId, async () => {
        if (readFee(key)) throw new Error("A launch fee payment is already saved for this draft. Reload the page to see it.");
        const quote = asset === "native"
          ? await chainApi<LaunchFeeQuote>(deploymentChain(config), `/launch-fee-quote?payer=${account}`) : undefined;
        const tx = quote ? launchFeeEthTx(config, quote) : launchFeeStableTx(config);
        const hash = await wallet.send(tx.to, tx.data, config, (txHash) => {
          sent = { ...launchFeeOf(asset, txHash, quote), pending: true };
          watching.current = sent.txHash;
          writeFee(key, sent);
          if (visible(key)) setPendingFee(sent);
        }, tx.value);
        // The wallet waited for two confirmations of a successful receipt; a repriced payment returns its new hash.
        const saved = readFee(key);
        if (sent && saved?.pending && saved.txHash === sent.txHash) paid(key, launchFeeOf(asset, hash, quote));
      });
    } catch (cause) {
      if (sent) { watching.current = ""; await settle(key, sent); }
      else if (visible(key)) setPayError(errorMessage(cause));
    } finally {
      if (sent && watching.current === sent.txHash) watching.current = "";
      if (alive.current) setPaying(false);
    }
  }
  const stable = LAUNCH_FEE_STABLE[deploymentChain(config)];

  return (
    <fieldset className="nft-step">
      <legend className="card-title">Launch for an NFT</legend>
      <label className="field">
        <span className="field-label">Collection contract</span>
        <input aria-label="Collection contract" className="mono" value={contract} spellCheck={false} autoComplete="off"
          onChange={(event) => setContract(event.target.value.trim())} />
      </label>
      {contract.toLowerCase() !== MUSES.contract.toLowerCase() &&
        <button type="button" className="text-button" onClick={() => setContract(MUSES.contract)}>Use Muses</button>}
      <label className="field">
        <span className="field-label">Token number</span>
        <input id={NFT_TOKEN_ID} name="nftTokenId" aria-label="Token number" value={tokenId} inputMode="numeric" autoComplete="off"
          aria-invalid={!!error} aria-describedby={error ? `${NFT_STATUS_ID} ${NFT_ERROR_ID}` : NFT_STATUS_ID}
          onChange={(event) => setTokenId(event.target.value.trim())} />
      </label>
      <p id={NFT_STATUS_ID} className="nft-status" role="status" aria-live="polite">{statusText}</p>
      {error && <p id={NFT_ERROR_ID} className="field-error" role="alert" tabIndex={-1}>{error}</p>}
      {nft && !isMuse(nft) && <section className="nft-fee" aria-labelledby={NFT_FEE_ID}>
        <h3 id={NFT_FEE_ID} className="field-label" tabIndex={-1}>Launch fee: $10</h3>
        {draft.launchFee ? <p role="status">Launch fee paid. <TxHash hash={draft.launchFee.txHash} config={config} /></p>
          : pendingFee ? <>
            <p role="status" aria-live="polite">Payment sent, waiting for confirmation. <TxHash hash={pendingFee.txHash} config={config} /></p>
            {!checking && !paying && <div className="button-row">
              <button type="button" className="secondary" onClick={() => void settle(feeKey, pendingFee)}>Check payment again</button>
            </div>}
          </>
          : <>
            <div className="button-row">
              {stable && <button type="button" className="primary" disabled={paying || !config.writesEnabled} onClick={() => void pay("stable")}>
                Pay 10 {stable.symbol}</button>}
              <button type="button" className="secondary" disabled={paying || !config.writesEnabled} onClick={() => void pay("native")}>Pay with ETH</button>
            </div>
            {paying && <p role="status">Confirm the payment in your wallet.</p>}
          </>}
        <p className="hint">The $10 goes to the platform treasury and is non-refundable. Pay once; your wallet confirms the exact amount.</p>
        {payError && <p className="field-error" role="alert">{payError}</p>}
      </section>}
      {nft ? <p className="hint">Creator fees go to this NFT's treasury <code className="wrap">{treasuryFor(nft)}</code> and follow the NFT when it is sold.
        {isMuse(nft) ? "" : " Unverified collection: musegod.fun does not endorse it."}</p> : null}
      <p className="hint">{NFT_DISCLAIMER}</p>
    </fieldset>
  );
}
