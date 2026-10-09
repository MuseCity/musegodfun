import { useEffect, useRef, useState } from "react";
import type { ChallengeRequest } from "../lib/api";
type Turnstile = { render: (container: HTMLElement, options: Record<string, unknown>) => string; remove: (id: string) => void };
declare global { interface Window { turnstile?: Turnstile } }
let script: Promise<void> | undefined;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  return script ??= new Promise<void>((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    tag.async = true;
    const failed = () => { clearTimeout(timer); tag.remove(); script = undefined; reject(new Error("Verification could not load. Your draft is saved; try again.")); };
    const timer = setTimeout(failed, 15_000);
    tag.onload = () => { clearTimeout(timer); if (window.turnstile) resolve(); else failed(); };
    tag.onerror = failed;
    document.head.appendChild(tag);
  });
}
export default function TurnstileGate() {
  const [request, setRequest] = useState<ChallengeRequest | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const pending = useRef<ChallengeRequest | null>(null), dialog = useRef<HTMLDialogElement>(null), container = useRef<HTMLDivElement>(null);
  const cancel = () => { pending.current?.reject(new Error("Verification cancelled. Your draft and payment are saved.")); pending.current = null; setRequest(null); };
  useEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<ChallengeRequest>).detail;
      if (pending.current) { next.reject(new Error("Complete the current verification, then retry.")); return; }
      if (!next.siteKey || !/^[a-zA-Z0-9_-]{1,100}$/.test(next.siteKey)) { next.reject(new Error("Verification is temporarily unavailable. Try again shortly.")); return; }
      pending.current = next; setError(""); setRequest(next);
    };
    window.addEventListener("musegod:challenge", receive);
    return () => { window.removeEventListener("musegod:challenge", receive); pending.current?.reject(new Error("Verification interrupted; your draft is saved.")); };
  }, []);
  useEffect(() => {
    if (!request) { dialog.current?.close(); return; }
    dialog.current?.showModal();
    let active = true, widget: string | undefined;
    void loadTurnstile().then(() => {
      if (!active || !container.current || !window.turnstile) return;
      widget = window.turnstile.render(container.current, { sitekey: request.siteKey, action: request.action,
        callback: (token: string) => { if (active) { request.resolve(token); pending.current = null; setRequest(null); } },
        "error-callback": () => { if (active) setError("Verification is temporarily unavailable. Try again shortly."); },
        "expired-callback": () => { if (active) setError("Verification expired. Please try again."); },
      });
    }).catch((cause) => active && setError(cause.message));
    return () => { active = false; if (widget) window.turnstile?.remove(widget); };
  }, [request, retry]);
  return <dialog ref={dialog} className="modal narrow turnstile-dialog" aria-labelledby="verification-title" onCancel={(event) => { event.preventDefault(); cancel(); }}>
    <h2 id="verification-title" className="modal-title">Quick verification</h2>
    <p>A quick check helps keep previews available. Your draft and completed payments are saved.</p>
    <div ref={container} className="turnstile-box" />
    {error && <p role="alert" className="field-error">{error}</p>}
    <div className="button-row">
      {error && <button type="button" className="secondary" onClick={() => { setError(""); setRetry((value) => value + 1); }}>Retry verification</button>}
      <button type="button" className="text-button" onClick={cancel}>Back to my draft</button>
    </div>
  </dialog>;
}
