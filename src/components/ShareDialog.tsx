import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";

export default function ShareDialog({ name, detail, icon, url, onClose }: {
  name: string;
  detail: string;
  icon: ReactNode;
  url: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  const text = `${name} on musegod.fun`;
  return <dialog ref={dialog} className="modal narrow share-dialog" aria-labelledby="share-title" onCancel={onClose} onClose={onClose}>
    <div className="modal-head">
      <h2 className="modal-title" id="share-title">Share {name}</h2>
      <button type="button" className="close-button" aria-label="Close share dialog" onClick={() => dialog.current?.close()}><X size={20} /></button>
    </div>
    <div className="share-identity">
      {icon}
      <div><b>{name}</b><span className="mono">{detail}</span></div>
    </div>
    <label className="field">
      <span className="field-label">Link</span>
      <span className="share-link">
        <input readOnly value={url} className="mono" onFocus={(event) => event.currentTarget.select()} aria-label="Token link" />
        <button type="button" className="secondary" onClick={() => {
          void navigator.clipboard.writeText(url).then(() => setCopied("done")).catch(() => setCopied("failed"));
        }}>{copied === "done" ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}</button>
      </span>
    </label>
    {copied === "failed" && <p role="alert" className="field-error">Copy failed. Select the link and copy it manually.</p>}
    <div className="button-row share-actions">
      <a className="secondary" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">Post on X ↗</a>
      <a className="secondary" href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">Share to Telegram ↗</a>
    </div>
  </dialog>;
}
