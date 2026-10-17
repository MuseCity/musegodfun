import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ApiError, chainApi } from "../lib/api";
import { deploymentChain, type TokenRecord } from "../lib/config";
import { normalizeProfileLink, PROFILE_FIELD_LABELS, PROFILE_FIELDS, ProfileLinkError, type ProfileField, type ProfileLinks, type TokenProfile } from "../lib/token-profile";
import { errorMessage } from "../lib/validation";
import { quoteNow } from "../lib/quote-clock";
import { useWallet } from "../lib/wallet";

const PLACEHOLDERS: Record<ProfileField, string> = {
  x: "@handle or x.com link", youtube: "@channel or youtube.com link", tiktok: "@handle or tiktok.com link",
  telegram: "username or t.me link", website: "https://",
};

/** The owner's editor for a coin's social links (tasks/token-ip-detail-plan.md §5). Saving signs typed data with the owner's wallet;
 * the server checks the signature and that the signer owns the profile. Name, symbol, image and story are fixed at launch. */
export default function ProfileEditor({ token, links, owner, onClose, onSaved }: {
  token: TokenRecord;
  links: ProfileLinks;
  /** Who may save, in one sentence. */
  owner: string;
  onClose: () => void;
  onSaved: (profile: TokenProfile) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const saving = useRef(false);
  const wallet = useWallet();
  const chainId = deploymentChain(token);
  const [values, setValues] = useState<ProfileLinks>({ ...links });
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  function check(field: ProfileField, value: string) {
    try { normalizeProfileLink(field, value); return ""; } catch (cause) { return cause instanceof ProfileLinkError ? cause.message : "Not a valid link."; }
  }
  async function save() {
    if (saving.current) return;
    setError("");
    const found = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, check(field, values[field])]).filter(([, message]) => message));
    setErrors(found);
    if (Object.keys(found).length) return;
    const normalized = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, normalizeProfileLink(field, values[field])])) as ProfileLinks;
    saving.current = true;
    try {
      if (!wallet.account) { await wallet.connect(); return; }
      if (wallet.chainId !== chainId) { setBusy("Switch your wallet network…"); await wallet.switchChain(chainId); }
      if (wallet.connection().chainId !== chainId) throw new Error(`Switch your wallet to ${chainId === 4663 ? "Robinhood Chain" : "Base"} to sign.`);
      setBusy("Sign in your wallet. This is free: no transaction and no gas.");
      const issuedAt = Math.floor(quoteNow());
      const { signer, signature } = await wallet.signProfile(token.address, normalized, chainId, issuedAt);
      setBusy("Saving…");
      const profile = await chainApi<TokenProfile>(chainId, `/tokens/${token.address}/profile`, { links: normalized, issuedAt, signer, signature });
      onSaved(profile);
      dialog.current?.close();
    } catch (cause) {
      const message = errorMessage(cause);
      setError(cause instanceof ApiError && cause.code === "PROFILE_EXPIRED"
        ? "The signature time could not be verified. Your device clock may be wrong; reload to sync with the server before saving again."
        : /^The wallet (has changed|network does not match)/.test(message)
          ? "The wallet changed. Open the editor again." : message);
    } finally { saving.current = false; setBusy(""); }
  }
  return <dialog ref={dialog} className="modal narrow profile-dialog" aria-labelledby="profile-title" onCancel={(event) => { if (saving.current) event.preventDefault(); else onClose(); }}
    onClose={() => { if (saving.current) dialog.current?.showModal(); else onClose(); }}>
    <div className="modal-head">
      <div>
        <h2 className="modal-title" id="profile-title">Edit profile</h2>
        <span className="mono hint">${token.symbol} · {token.name}</span>
      </div>
      <button type="button" className="close-button" aria-label="Close profile editor" disabled={!!busy} onClick={() => dialog.current?.close()}><X size={20} /></button>
    </div>
    <p>{owner} Saving signs a message with that wallet: nothing goes on-chain and there is no gas. Leave a field empty to hide it.</p>
    <form className="profile-fields" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {PROFILE_FIELDS.map((field) => <label className="field" key={field}>
        <span className="field-label">{PROFILE_FIELD_LABELS[field]}</span>
        <input className="input" name={field} value={values[field]} placeholder={PLACEHOLDERS[field]} autoComplete="off" spellCheck={false}
          maxLength={220} aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `profile-${field}-error` : undefined} disabled={!!busy}
          onChange={(event) => { const value = event.target.value; setValues((current) => ({ ...current, [field]: value })); if (errors[field]) setErrors((current) => ({ ...current, [field]: "" })); }}
          onBlur={() => setErrors((current) => ({ ...current, [field]: check(field, values[field]) }))} />
        {errors[field] && <span className="field-error" id={`profile-${field}-error`} role="alert">{errors[field]}</span>}
      </label>)}
      <div className="profile-fixed">
        <b>Set at launch, cannot change.</b> Name, symbol, image and story live in the coin's on-chain metadata.
      </div>
      <p className="trade-progress" role="status">{busy}</p>
      {error && <p className="notice error" role="alert"><span>{error}</span></p>}
      <div className="button-row profile-actions">
        <button type="button" className="secondary" onClick={() => dialog.current?.close()} disabled={!!busy}>Cancel</button>
        <button type="submit" className="primary" disabled={!!busy}>{wallet.account ? "Sign and save" : "Connect wallet"}</button>
      </div>
    </form>
  </dialog>;
}
