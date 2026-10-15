import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { deploymentChain, explorerFor, shortAddress, type RuntimeConfig } from "../lib/config";
import { LAUNCH_FEE_STABLE, LAUNCH_FEE_USD } from "../lib/launch-fee";
import { MUSES, isMuse, nftKey, treasuryFor, type NftRef, type NftStatus } from "../lib/nft-mode";
import { FEE_MAYBE_SENT, FEE_WAITING, formatFeeEth, readNftStatus, type DraftLaunchFee, type LaunchFeeState, type NftChecked } from "../lib/nft-client";
import { NftPicker, Thumb, type NftPick } from "./NftPicker";
import { useLaunchFee } from "../lib/use-launch-fee";
import { errorMessage, nftRefSchema, type LaunchInput } from "../lib/validation";

/** Element ids the create form uses to move focus to the field to fix. */
export const NFT_TOKEN_ID = "nft-launch-token", NFT_ERROR_ID = "nft-launch-error", NFT_FEE_ID = "nft-launch-fee";
export const NFT_DISCLAIMER = "Not investment advice. musegod.fun does not endorse NFT collections; an unverified collection may imitate another.";
/** What the create form needs from the step to decide whether review may open. `checked`: the NFT and account the live check passed for,
 * or null (a restored NFT stays in the draft while it is checked again, so the draft alone does not say it passed). */
export type NftStepStatus = { status: string; fee: LaunchFeeState; checked: NftChecked | null };
export type NftFeeRejection = { code: "NFT_FEE_PENDING" | "NFT_FEE_INVALID"; message: string };

export function NftFeeNotice({ rejection, paid, onDiscard }: { rejection: NftFeeRejection; paid: boolean; onDiscard: () => void }) {
  return <div role="alert" className="nft-warning">
    {rejection.code === "NFT_FEE_PENDING"
      ? <p>This payment is still confirming. {rejection.message} Keep this payment and review again in a minute.</p>
      : <><p>This payment could not be verified. {rejection.message} Pay a new fee.</p>
        {paid && <div className="button-row"><button type="button" className="secondary" onClick={onDiscard}>Pay a new fee</button></div>}</>}
  </div>;
}

const LAUNCH_MODES = [
  [false, "Normal", "Any coin. You keep the creator share of trading fees."],
  [true, "NFT", `Bound to an NFT you hold. Creator fees go to the NFT's treasury and move with the NFT. Muses launch free; other NFTs pay $${LAUNCH_FEE_USD}.`],
] as const;

/** The launch type, as two large choices; each radio is named by its title alone and described by its note. */
export function LaunchModeSwitch({ nftMode, disabled, onChange }: { nftMode: boolean; disabled?: boolean; onChange: (nftMode: boolean) => void }) {
  return (
    <fieldset className="launch-mode" disabled={disabled}>
      <legend className="field-label">Launch type</legend>
      {LAUNCH_MODES.map(([value, label, note]) => <label key={label}>
        <input type="radio" name="launchMode" checked={nftMode === value} onChange={() => onChange(value)}
          aria-labelledby={`launch-mode-${label}`} aria-describedby={`launch-mode-${label}-note`} />
        <span className="launch-mode-text">
          <span id={`launch-mode-${label}`} className="launch-mode-title">{label}</span>
          <span id={`launch-mode-${label}-note`} className="launch-mode-note">{note}</span>
        </span>
      </label>)}
    </fieldset>
  );
}

function TxHash({ hash, config }: { hash: Hex; config: RuntimeConfig }) {
  const explorer = explorerFor(config);
  return <><code className="wrap">{hash}</code>{explorer && <> <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction</a></>}</>;
}

/** Step one of an NFT launch: the NFT, its live check, and the wallet's $10 fee. `onChange` reports a confirmed NFT, and `undefined` when
 * the person changes the NFT or the check says no (not ERC-721, not controlled, already launched); `user`: the person changed the NFT.
 * The NFT the draft already holds (a reload, another tab, a draft link) stays while it is checked again, and through a check that could
 * not run (the error shows with Retry); `checked` in the status tells review whether the check passed, so review never proceeds on it. */
export function NftLaunchStep({ config, account, draft, connecting, onConnect, error = "", feeRejected, onChange, onCheck, onFee, onPrefill, onStatus }: {
  config: RuntimeConfig; account: Address | null; draft: LaunchInput; connecting: boolean; onConnect: () => void; error?: string; feeRejected?: NftFeeRejection | null;
  onChange: (nft: NftRef | undefined, user: boolean) => void; onCheck: () => void; onFee: (fee: DraftLaunchFee | undefined) => void;
  onPrefill?: (nftName: string) => void; onStatus: (status: NftStepStatus) => void;
}) {
  const nft = draft.nft;
  const [contract, setContract] = useState<string>(nft?.contract ?? MUSES.contract);
  const [tokenId, setTokenId] = useState(nft?.tokenId ?? "");
  // How the NFT is chosen: from the wallet's list (default), or typed. A draft that already holds an NFT (a reload, another tab, a draft
  // link) opens on its summary, so it is checked again rather than hidden behind an empty list.
  const [manual, setManual] = useState(false), [picking, setPicking] = useState(!nft);
  const [focusSearch, setFocusSearch] = useState(false);
  const clearSearchFocus = useCallback(() => setFocusSearch(false), []);
  const contractInput = useRef<HTMLInputElement>(null), selectedName = useRef<HTMLSpanElement>(null);
  const showPicker = () => {
    setManual(false); setPicking(true); setFocusSearch(true);
  };
  const picked = useRef(new Map<string, { name?: string; image?: string }>());
  const choose = (pick: NftPick) => {
    const key = nftKey({ chainId: deploymentChain(config), contract: pick.contract, tokenId: pick.tokenId });
    picked.current.set(key, { name: pick.name, image: pick.image });
    edit(() => { setContract(pick.contract); setTokenId(pick.tokenId); });
    setPicking(false); setManual(false);
    requestAnimationFrame(() => selectedName.current?.focus());
  };
  const [status, setStatus] = useState<NftStatus | null>(null), [statusFor, setStatusFor] = useState("");
  const [checkError, setCheckError] = useState(""), [attempt, setAttempt] = useState(0);
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
  // The check a result belongs to: a result for an earlier NFT, account or attempt never counts for the current one.
  const run = `${candidateKey}|${account ?? ""}|${config.chainId}|${config.deploymentChainId}|${attempt}`;
  useEffect(() => {
    const user = edited.current;
    edited.current = false;
    setStatus(null); setCheckError("");
    latest.current.onCheck();
    // The NFT the draft already holds is checked again without being dropped; any other NFT is not in the draft until it passes.
    if (user || !candidate || reported.current !== candidateKey) report(undefined, user);
    if (!account || !candidate) return;
    let active = true;
    const timer = setTimeout(() => {
      readNftStatus(config, candidate, account).then((result) => {
        if (!active) return;
        setStatus(result); setStatusFor(run);
        if (!result.erc721 || !result.controls || result.alreadyLaunched) { report(undefined, user); return; }
        report(candidate, user);
        const prefillName = result.free ? result.name : picked.current.get(candidateKey)?.name;
        if (prefillName && prefilled.current !== candidateKey) {
          prefilled.current = candidateKey;
          latest.current.onPrefill?.(prefillName);
        }
      }, (cause: unknown) => { if (active) setCheckError(errorMessage(cause)); });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [candidateKey, account, config.chainId, config.deploymentChainId, attempt]);
  const current = statusFor === run ? status : null;
  const passed = !!account && !!candidate && !checkError && !!current && current.erc721 && current.controls && !current.alreadyLaunched;

  const statusText = !account ? "Connect the wallet that holds the NFT."
    : !manual && picking && !nft ? "Choose an NFT from your wallet, or enter a contract and token number."
    : tokenId && !parsed.success ? parsed.error.issues[0]?.message ?? "Check the contract and token number."
    : !candidate ? "Enter the token number to check it."
    : checkError ? checkError
    : !current ? "Checking this NFT…"
    : !current.erc721 ? "This contract is not an ERC-721 collection."
    : !current.controls ? "This wallet does not hold the NFT and has no delegation for it."
    : current.alreadyLaunched ? "This NFT already has its coin."
    : current.free ? "Muse launches are free. Muse coins pair with MUSEGOD."
    : "Launching for this NFT costs $10, paid before the launch.";

  const fee = useLaunchFee(config, account, draft.launchFee, (next) => latest.current.onFee(next));
  const checkedFor = passed && account ? `${candidateKey}|${account}` : "";
  useEffect(() => {
    latest.current.onStatus({ status: statusText, fee: fee.state, checked: passed && account ? { nft: candidateKey, account } : null });
  }, [statusText, fee.state, checkedFor]);
  const stable = LAUNCH_FEE_STABLE[deploymentChain(config)], record = fee.record;
  // The $10 is non-refundable: payment opens only once the check has passed for this NFT. A payment already made still shows below.
  const needsFee = !!nft && !isMuse(nft) && passed;
  // A fee paid before the verified vault exists could not launch anything, so payment opens with it.
  const vaultReady = !!config.nftMode?.vaultFactory, payBlocked = fee.paying || !config.writesEnabled || !vaultReady;

  return (
    <fieldset className="nft-step">
      <legend className="card-title">Launch for an NFT</legend>
      {manual ? <>
        <label className="field">
          <span className="field-label">Collection contract</span>
          <input ref={contractInput} aria-label="Collection contract" className="mono" value={contract} spellCheck={false} autoComplete="off"
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
        <button type="button" className="text-button" onClick={showPicker}>Choose from your wallet instead</button>
      </> : picking ? <div><NftPicker key={`${account}|${config.chainId}|${config.deploymentChainId}`} config={config} account={account} connecting={connecting} onConnect={onConnect} onPick={choose}
        focusSearch={focusSearch} onSearchFocused={clearSearchFocus}
        onManual={() => { setManual(true); requestAnimationFrame(() => contractInput.current?.focus()); }} />
        {nft && <button type="button" className="secondary" onClick={() => { setPicking(false); requestAnimationFrame(() => selectedName.current?.focus()); }}>Keep #{nft.tokenId}</button>}</div> :
        <div className="nft-selected">
          <Thumb size={56} src={candidate ? picked.current.get(candidateKey)?.image : undefined} />
          <div className="nft-collection-text">
            <span ref={selectedName} className="nft-collection-name" tabIndex={-1}>{(candidate && picked.current.get(candidateKey)?.name) ?? `${candidate && isMuse(candidate) ? "Muse" : "NFT"} #${tokenId}`}</span>
            <span className="hint mono">{shortAddress(contract)} · #{tokenId}</span>
          </div>
          <button type="button" className="secondary" onClick={showPicker}>Change</button>
        </div>}
      <p id="nft-launch-status" className="nft-status" role="status" aria-live="polite">{statusText}</p>
      {checkError && account && candidate && <button type="button" className="text-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
      {error && <p id={NFT_ERROR_ID} className="field-error" role="alert" tabIndex={-1}>{error}</p>}
      {/* The fee state shows whenever a payment exists, even while the NFT check is pending or failed. */}
      {(record || needsFee || feeRejected) && <section className="nft-fee" aria-labelledby={NFT_FEE_ID}>
        <h3 id={NFT_FEE_ID} className="field-label" tabIndex={-1}>Launch fee: $10</h3>
        {/* One state at a time: paid, undecided, waiting for confirmation, the wallet prompt, possibly sent, or the pay buttons. */}
        {record?.state === "paid" ? <p role="status">Launch fee paid. It covers one paid NFT launch from this wallet. <TxHash hash={record.fee.txHash} config={config} /></p>
          : record && fee.unknown ? <p role="status" aria-live="polite" className="nft-warning">{fee.unknown}</p>
          : record?.state === "pending" ? <p role="status" aria-live="polite">{FEE_WAITING} <TxHash hash={record.txHash} config={config} /></p>
          : fee.paying ? <p role="status">Confirm the payment in your wallet.</p>
          : record?.state === "sending" ? <p role="status" aria-live="polite" className="nft-warning">{FEE_MAYBE_SENT}</p>
          : fee.ethQuote && needsFee ? <div className="nft-eth-quote">
            <p className="nft-amount">Pay {formatFeeEth(fee.ethQuote.wei)} ETH (about $10)</p>
            <p className="hint">This price is valid for one minute. Your wallet asks you to confirm the same amount.</p>
            <div className="button-row">
              <button type="button" className="primary" disabled={fee.paying} onClick={fee.payEth}>Pay {formatFeeEth(fee.ethQuote.wei)} ETH</button>
              <button type="button" className="secondary" disabled={fee.paying} onClick={fee.cancelEthQuote}>Cancel</button>
            </div>
          </div>
          : needsFee ? <>
            {!vaultReady && <p className="nft-warning" role="status">Launch-fee payment opens when the fee vault is available on this network.</p>}
            <div className="button-row">
              {stable && <button type="button" className="primary" disabled={payBlocked} onClick={fee.payStable}>Pay 10 {stable.symbol}</button>}
              <button type="button" className="secondary" disabled={payBlocked} onClick={fee.requestEthQuote}>Pay with ETH</button>
            </div>
          </> : null}
        {record && record.state !== "paid" && !fee.paying && <div className="button-row">
          <button type="button" className="secondary" disabled={fee.checking} onClick={fee.checkAgain}>{fee.checking ? "Checking…" : "Check again"}</button>
          {fee.unknown && <button type="button" className="secondary" onClick={fee.discard}>No payment was sent — pay again</button>}
        </div>}
        {feeRejected && <NftFeeNotice rejection={feeRejected} paid={record?.state === "paid"} onDiscard={fee.discard} />}
        {fee.notice && <p className="field-error" role="alert">{fee.notice}</p>}
        <p className="nft-warning">The $10 goes to the platform treasury and is non-refundable.</p>
      </section>}
      {nft ? <p className="hint">Creator fees go to this NFT's treasury <code className="wrap">{treasuryFor(nft)}</code> and follow the NFT when it is sold.</p> : null}
      {nft && !isMuse(nft) ? <p className="nft-warning">Unverified collection: musegod.fun does not endorse it.</p> : null}
      <p className="nft-warning">{NFT_DISCLAIMER}</p>
    </fieldset>
  );
}
