import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { deploymentChain, explorerFor, type RuntimeConfig } from "../lib/config";
import { LAUNCH_FEE_STABLE } from "../lib/launch-fee";
import { MUSES, isMuse, nftKey, treasuryFor, type NftRef, type NftStatus } from "../lib/nft-mode";
import { FEE_MAYBE_SENT, formatFeeEth, readNftStatus, type DraftLaunchFee, type LaunchFeeState } from "../lib/nft-client";
import { useLaunchFee } from "../lib/use-launch-fee";
import { errorMessage, nftRefSchema, type LaunchInput } from "../lib/validation";

/** Element ids the create form uses to move focus to the field to fix. */
export const NFT_TOKEN_ID = "nft-launch-token", NFT_ERROR_ID = "nft-launch-error", NFT_FEE_ID = "nft-launch-fee";
export const NFT_DISCLAIMER = "Not investment advice. musegod.fun does not endorse NFT collections; an unverified collection may imitate another.";
/** What the create form needs from the step to decide whether review may open. */
export type NftStepStatus = { status: string; fee: LaunchFeeState };

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

function TxHash({ hash, config }: { hash: Hex; config: RuntimeConfig }) {
  const explorer = explorerFor(config);
  return <><code className="wrap">{hash}</code>{explorer && <> <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction</a></>}</>;
}

/** Step one of an NFT launch: the NFT, its live check, and the wallet's $10 fee. `onChange` reports a confirmed NFT only, and
 * `undefined` while a check is pending or failed (`user`: the person changed the NFT), so review can never proceed as a normal coin. */
export function NftLaunchStep({ config, account, draft, error = "", feeRejected = "", onChange, onCheck, onFee, onPrefill, onStatus }: {
  config: RuntimeConfig; account: Address | null; draft: LaunchInput; error?: string; feeRejected?: string;
  onChange: (nft: NftRef | undefined, user: boolean) => void; onCheck: () => void; onFee: (fee: DraftLaunchFee | undefined) => void;
  onPrefill?: (museName: string) => void; onStatus: (status: NftStepStatus) => void;
}) {
  const nft = draft.nft;
  const [contract, setContract] = useState<string>(nft?.contract ?? MUSES.contract);
  const [tokenId, setTokenId] = useState(nft?.tokenId ?? "");
  const [status, setStatus] = useState<NftStatus | null>(null);
  const [checkError, setCheckError] = useState("");
  // Parent callbacks are read through a ref, so a new callback identity never re-runs the check.
  const latest = useRef({ onChange, onCheck, onFee, onPrefill, onStatus });
  latest.current = { onChange, onCheck, onFee, onPrefill, onStatus };
  // The NFT the parent holds; a report that would not change it is skipped, so `undefined` is never sent twice in a row.
  const reported = useRef("");
  reported.current = nft ? nftKey(nft) : "";
  const report = (next: NftRef | undefined, user: boolean) => {
    const key = next ? nftKey(next) : "";
    if (key === reported.current) return;
    reported.current = key;
    latest.current.onChange(next, user);
  };
  const edited = useRef(false), prefilled = useRef("");
  const edit = (apply: () => void) => { edited.current = true; apply(); };
  const parsed = nftRefSchema.safeParse({ chainId: deploymentChain(config), contract, tokenId });
  const candidate = parsed.success ? parsed.data : null, candidateKey = candidate ? nftKey(candidate) : "";
  useEffect(() => {
    const user = edited.current;
    edited.current = false;
    setStatus(null); setCheckError("");
    latest.current.onCheck();
    report(undefined, user);
    if (!account || !candidate) return;
    let active = true;
    const timer = setTimeout(() => {
      readNftStatus(config, candidate, account).then((result) => {
        if (!active) return;
        setStatus(result);
        if (!result.erc721 || !result.controls || result.alreadyLaunched) return;
        report(candidate, user);
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

  const fee = useLaunchFee(config, account, draft.launchFee, (next) => latest.current.onFee(next));
  useEffect(() => { latest.current.onStatus({ status: statusText, fee: fee.state }); }, [statusText, fee.state]);
  const stable = LAUNCH_FEE_STABLE[deploymentChain(config)], record = fee.record;
  const needsFee = !!nft && !isMuse(nft);

  return (
    <fieldset className="nft-step">
      <legend className="card-title">Launch for an NFT</legend>
      <label className="field">
        <span className="field-label">Collection contract</span>
        <input aria-label="Collection contract" className="mono" value={contract} spellCheck={false} autoComplete="off"
          onChange={(event) => edit(() => setContract(event.target.value.trim()))} />
      </label>
      {contract.toLowerCase() !== MUSES.contract.toLowerCase() &&
        <button type="button" className="text-button" onClick={() => edit(() => setContract(MUSES.contract))}>Use Muses</button>}
      <label className="field">
        <span className="field-label">Token number</span>
        <input id={NFT_TOKEN_ID} name="nftTokenId" aria-label="Token number" value={tokenId} inputMode="numeric" autoComplete="off"
          aria-invalid={!!error} aria-describedby={error ? `nft-launch-status ${NFT_ERROR_ID}` : "nft-launch-status"}
          onChange={(event) => edit(() => setTokenId(event.target.value.trim()))} />
      </label>
      <p id="nft-launch-status" className="nft-status" role="status" aria-live="polite">{statusText}</p>
      {error && <p id={NFT_ERROR_ID} className="field-error" role="alert" tabIndex={-1}>{error}</p>}
      {/* The fee state shows whenever a payment exists, even while the NFT check is pending or failed. */}
      {(record || needsFee || feeRejected) && <section className="nft-fee" aria-labelledby={NFT_FEE_ID}>
        <h3 id={NFT_FEE_ID} className="field-label" tabIndex={-1}>Launch fee: $10</h3>
        {/* One state at a time: paid, undecided, waiting for confirmation, the wallet prompt, possibly sent, or the pay buttons. */}
        {record?.state === "paid" ? <p role="status">Launch fee paid. It covers one paid NFT launch from this wallet. <TxHash hash={record.fee.txHash} config={config} /></p>
          : record && fee.unknown ? <p role="status" aria-live="polite" className="nft-warning">{fee.unknown}
            {record.state === "pending" && <> <TxHash hash={record.txHash} config={config} /></>}</p>
          : record?.state === "pending" ? <p role="status" aria-live="polite">Payment sent, waiting for confirmation. <TxHash hash={record.txHash} config={config} /></p>
          : fee.paying ? <p role="status">Confirm the payment in your wallet.</p>
          : record?.state === "sending" ? <p role="status" aria-live="polite" className="nft-warning">{FEE_MAYBE_SENT}</p>
          : fee.ethQuote ? <div className="nft-eth-quote">
            <p className="nft-amount">Pay {formatFeeEth(fee.ethQuote.wei)} ETH (about $10)</p>
            <p className="hint">This price is valid for one minute. Your wallet asks you to confirm the same amount.</p>
            <div className="button-row">
              <button type="button" className="primary" disabled={fee.paying} onClick={fee.payEth}>Pay {formatFeeEth(fee.ethQuote.wei)} ETH</button>
              <button type="button" className="secondary" disabled={fee.paying} onClick={fee.cancelEthQuote}>Cancel</button>
            </div>
          </div>
          : needsFee ? <div className="button-row">
            {stable && <button type="button" className="primary" disabled={fee.paying || !config.writesEnabled} onClick={fee.payStable}>Pay 10 {stable.symbol}</button>}
            <button type="button" className="secondary" disabled={fee.paying || !config.writesEnabled} onClick={fee.requestEthQuote}>Pay with ETH</button>
          </div> : null}
        {record && record.state !== "paid" && !fee.paying && <div className="button-row">
          <button type="button" className="secondary" disabled={fee.checking} onClick={fee.checkAgain}>{fee.checking ? "Checking…" : "Check again"}</button>
          {fee.unknown && <button type="button" className="secondary" onClick={fee.discard}>No payment was sent — pay again</button>}
        </div>}
        {feeRejected && <div role="alert" className="nft-warning">
          <p>This payment could not be verified. {feeRejected} If it is still confirming, wait a minute and review again. Otherwise, pay a new fee.</p>
          {record?.state === "paid" && <div className="button-row">
            <button type="button" className="secondary" onClick={fee.discard}>Pay a new fee</button>
          </div>}
        </div>}
        {fee.notice && <p className="field-error" role="alert">{fee.notice}</p>}
        <p className="nft-warning">The $10 goes to the platform treasury and is non-refundable.</p>
      </section>}
      {nft ? <p className="hint">Creator fees go to this NFT's treasury <code className="wrap">{treasuryFor(nft)}</code> and follow the NFT when it is sold.</p> : null}
      {nft && !isMuse(nft) ? <p className="nft-warning">Unverified collection: musegod.fun does not endorse it.</p> : null}
      <p className="nft-warning">{NFT_DISCLAIMER}</p>
    </fieldset>
  );
}
