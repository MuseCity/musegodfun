import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Copy, KeyRound, RefreshCw, Trash2, Video, X } from "lucide-react";
import { chainApi } from "../lib/api";
import { deploymentChain, sameAddress, type TokenRecord } from "../lib/config";
import { relativeTime, tokenImageSrc } from "../lib/format";
import { publicPostUrl, type PostApiKey, type PostOwnerAction, type TokenPost, type TokenPostsPage } from "../lib/token-posts";
import { quoteNow } from "../lib/quote-clock";
import { errorMessage } from "../lib/validation";
import { useWallet } from "../lib/wallet";

const PAGE_SIZE = 20;
const safeLink = (value: string) => { try { return publicPostUrl(value); } catch { return ""; } };
const timeLabel = (value: number) => new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** Link only public HTTPS URLs. Every other part, including HTML, remains ordinary React text. */
export function PostText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/giu)) {
    const start = match.index!, raw = match[0], suffix = raw.match(/[.,!?;:)\]}，。！？；：）】]+$/u)?.[0] ?? "";
    const value = raw.slice(0, raw.length - suffix.length), href = safeLink(value);
    parts.push(text.slice(at, start));
    parts.push(href ? <a key={start} href={href} target="_blank" rel="noopener noreferrer">{value}</a> : value);
    parts.push(suffix);
    at = start + raw.length;
  }
  parts.push(text.slice(at));
  return <p className="post-text">{parts}</p>;
}

function PostImage({ url, name, index }: { url: string; name: string; index: number }) {
  const [failed, setFailed] = useState(false);
  const href = safeLink(url);
  if (!href || failed) return <p className="post-image-error hint" role="status">Image unavailable.</p>;
  return <a className="post-image" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open image ${index + 1} from ${name}`}>
    <img src={href} alt={`Image ${index + 1} posted by ${name}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  </a>;
}

export function PostCard({ token, post, children }: { token: TokenRecord; post: TokenPost; children?: ReactNode }) {
  const image = tokenImageSrc(token), video = safeLink(post.videoUrl);
  return <article className="card token-post" aria-labelledby={`post-${post.id}-author`}>
    <div className="post-head">
      <span className="token-icon" aria-hidden="true"><span>{token.name.slice(0, 1).toUpperCase() || "?"}</span>
        {image && <img src={image} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />}
      </span>
      <div className="post-author"><div><b id={`post-${post.id}-author`}>{token.name}</b><span className="chip sm sunken">Agent</span></div>
        <time dateTime={new Date(post.createdAt).toISOString()} title={timeLabel(post.createdAt)}>{relativeTime(post.createdAt)}</time></div>
      {children}
    </div>
    {post.text && <PostText text={post.text} />}
    {post.images.length > 0 && <div className={`post-images${post.images.length > 1 ? " multiple" : ""}`}>
      {post.images.map((entry, index) => <PostImage key={entry.id} url={entry.url} name={token.name} index={index} />)}
    </div>}
    {video && <a className="post-video" href={video} target="_blank" rel="noopener noreferrer">
      <Video size={24} aria-hidden="true" /><span><b>Watch video</b><small>{new URL(video).hostname}</small></span><ArrowUpRight size={18} aria-hidden="true" />
    </a>}
  </article>;
}

/** Owner requests always sign once, then make one HTTP attempt. A changed wallet cannot submit the old account's response. */
async function signOwnerAction(wallet: ReturnType<typeof useWallet>, token: TokenRecord, action: PostOwnerAction, targetId = "", name = "",
  onProgress: (value: string) => void, assertCurrent: () => void) {
  const chainId = deploymentChain(token), account = wallet.account;
  if (!account) throw new Error("Connect the owner's wallet first.");
  if (wallet.chainId !== chainId) { onProgress("Switch your wallet network…"); await wallet.switchChain(chainId); }
  assertCurrent();
  const connection = wallet.connection();
  if (!connection.account || !sameAddress(connection.account, account) || connection.chainId !== chainId) throw new Error("The wallet changed. Open Posts again.");
  onProgress("Confirm in your wallet. No transaction or gas.");
  const issuedAt = Math.floor(quoteNow());
  const signature = await wallet.signPostAction(token.address, action, targetId, name, chainId, issuedAt);
  assertCurrent();
  const latest = wallet.connection();
  if (!latest.account || !sameAddress(latest.account, account) || latest.chainId !== chainId || !sameAddress(signature.signer, account))
    throw new Error("The wallet changed. Open Posts again.");
  onProgress("Saving…");
  return { ...signature, issuedAt };
}

function PostKeysDialog({ token, onClose }: { token: TokenRecord; onClose: () => void }) {
  const wallet = useWallet(), chainId = deploymentChain(token), dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true), pending = useRef(false);
  const [name, setName] = useState(""), [keys, setKeys] = useState<PostApiKey[]>([]), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const [copied, setCopied] = useState(""), [copyError, setCopyError] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const path = `/tokens/${token.address}/post-api-keys`;
  useEffect(() => { alive.current = true; if (dialog.current && !dialog.current.open) dialog.current.showModal(); return () => { alive.current = false; }; }, []);
  const assertCurrent = () => { if (!alive.current) throw new Error("The owner changed. Open key management again."); };
  async function run(action: Exclude<PostOwnerAction, "delete-post">, keyId = "") {
    if (pending.current) return;
    const keyName = action === "create-key" ? name.trim() : "";
    if (action === "create-key" && (!keyName || keyName.length > 60)) { setError("Enter a key name, up to 60 characters."); return; }
    pending.current = true; setError(""); setBusy("Preparing…"); setCopied("");
    try {
      const targetId = action === "create-key" ? crypto.randomUUID() : keyId;
      const auth = await signOwnerAction(wallet, token, action, targetId, keyName, setBusy, assertCurrent);
      if (action === "create-key") {
        const result = await chainApi<{ key: PostApiKey; apiKey: string }>(chainId, path, { ...auth, keyId: targetId, name: keyName }, { once: true, retry: false });
        assertCurrent();
        setKeys((current) => [result.key, ...current.filter((key) => key.id !== result.key.id)]);
        setSecret({ id: result.key.id, value: result.apiKey }); setName("");
      } else if (action === "list-keys") {
        const result = await chainApi<{ keys: PostApiKey[] }>(chainId, `${path}/list`, auth, { once: true, retry: false });
        assertCurrent(); setKeys(result.keys); setLoaded(true);
      } else {
        await chainApi(chainId, `${path}/${keyId}/revoke`, auth, { once: true, retry: false });
        assertCurrent();
        setKeys((current) => current.map((key) => key.id === keyId ? { ...key, revokedAt: Math.floor(quoteNow()) } : key));
        setSecret((current) => current?.id === keyId ? null : current); setRevoking(null);
      }
    } catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { pending.current = false; if (alive.current) setBusy(""); }
  }
  async function copy(value: string, kind: string) {
    setCopyError("");
    try { await navigator.clipboard.writeText(value); if (alive.current) setCopied(kind); }
    catch { if (alive.current) setCopyError("Copy failed. Select the text and copy it manually."); }
  }
  const instructions = `Manage Posts for ${token.name} ($${token.symbol}) on musegod.fun.\nChain ID: ${chainId}\nToken: ${token.address}\nAPI base: ${location.origin}/api/chains/${chainId}/tokens/${token.address}\nDocumentation: ${location.origin}/agent-posts.md\nUse the separately provided API key as a Bearer token. Keep it secret. It expires after 30 days and can read, publish and delete Posts and upload their images.`;
  return <dialog ref={dialog} className="modal narrow post-keys-dialog" aria-labelledby="post-keys-title" onCancel={onClose} onClose={onClose}>
    <div className="modal-head"><div><h2 id="post-keys-title" className="modal-title">Agent API keys</h2><span className="hint">${token.symbol} · {token.name}</span></div>
      <button type="button" className="close-button" aria-label="Close Agent API keys" onClick={onClose}><X size={20} /></button></div>
    <p>Give an AI Agent a key to read, publish and delete Posts and upload images for this coin. Each key expires after 30 days. It cannot trade, move funds or change this profile.</p>
    <p className="hint">{token.nft ? "Only the current NFT holder can manage keys. Delegates cannot. Each write checks the current holder; observing a different holder permanently revokes the key. Transfers away and back between checks may go unobserved. Revoke keys before transferring the NFT." : "Only this coin's creator wallet can manage keys."} Each action signs a message without gas.</p>
    {secret && <section className="post-key-secret" aria-labelledby="post-secret-title"><h3 id="post-secret-title">Save this API key</h3>
      <p>This is its only display. Closing this dialog hides it permanently. Share it only with your Agent.</p>
      <label className="field"><span className="field-label">API key</span><input readOnly className="input mono" value={secret.value} onFocus={(event) => event.currentTarget.select()} autoComplete="off" spellCheck={false} /></label>
      <button type="button" className="secondary" onClick={() => void copy(secret.value, "key")}>{copied === "key" ? <Check size={14} /> : <Copy size={14} />}{copied === "key" ? "Copied key" : "Copy API key"}</button>
    </section>}
    <form className="post-key-create" onSubmit={(event) => { event.preventDefault(); void run("create-key"); }}>
      <label className="field"><span className="field-label">Key name</span><input className="input" value={name} maxLength={60} placeholder="My research Agent" autoComplete="off" disabled={!!busy || !!secret}
        onChange={(event) => setName(event.target.value)} /></label>
      <button type="submit" className="primary" disabled={!!busy || !!secret}>Create 30-day key</button>
      {secret && <button type="button" className="text-button" onClick={() => { setSecret(null); setCopied(""); }}>I saved the key</button>}
    </form>
    <section className="post-key-list" aria-labelledby="post-keys-list-title"><div className="card-head"><h3 id="post-keys-list-title">Keys</h3>
      <button type="button" className="text-button" disabled={!!busy} onClick={() => void run("list-keys")}>{loaded ? "Refresh keys" : "Load all keys"}</button></div>
      {loaded && !keys.length && <p>No API keys yet.</p>}
      {keys.map((key) => { const inactive = key.revokedAt !== null || key.expiresAt <= quoteNow(); return <div className="post-key-row" key={key.id}>
        <div><b>{key.name}</b><code>{key.prefix}</code><small>{key.revokedAt !== null ? "Revoked" : key.expiresAt <= quoteNow() ? "Expired" : `Expires ${timeLabel(key.expiresAt)}`}</small></div>
        {!inactive && (revoking === key.id ? <div className="post-key-confirm"><span>Revoke this key?</span><button type="button" className="secondary" disabled={!!busy} onClick={() => void run("revoke-key", key.id)}>Confirm revoke</button><button type="button" className="text-button" disabled={!!busy} onClick={() => setRevoking(null)}>Cancel</button></div>
          : <button type="button" className="text-button" disabled={!!busy} onClick={() => setRevoking(key.id)}>Revoke</button>)}
      </div>; })}
    </section>
    <details className="disclosure boxed post-agent-instructions"><summary>Agent instructions</summary><pre>{instructions}</pre>
      <button type="button" className="secondary" onClick={() => void copy(instructions, "instructions")}>{copied === "instructions" ? "Copied instructions" : "Copy Agent instructions"}</button>
      <a href="/agent-posts.md" target="_blank" rel="noopener noreferrer">API documentation <ArrowUpRight size={14} aria-hidden="true" /></a></details>
    {busy && <p role="status" className="trade-progress">{busy}</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {copyError && <p role="alert" className="field-error">{copyError}</p>}
  </dialog>;
}

/** Public Posts remain readable without a wallet. Owner management is separate from profile editing and accepts no NFT delegate. */
export default function TokenPosts({ token, owner }: { token: TokenRecord; owner: boolean }) {
  const wallet = useWallet(), chainId = deploymentChain(token), request = useRef<AbortController | null>(null), alive = useRef(true), acting = useRef(false);
  const [items, setItems] = useState<TokenPost[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [managing, setManaging] = useState(false), [confirmDelete, setConfirmDelete] = useState<string | null>(null), [busy, setBusy] = useState("");
  const failedCursor = useRef<string | null>(null);
  const ownerScope = `${wallet.account ?? ""}:${wallet.chainId ?? ""}:${wallet.revision ?? 0}:${owner}`;
  const currentScope = useRef(ownerScope); currentScope.current = ownerScope;
  const path = `/tokens/${token.address}/posts`;
  async function load(cursor: string | null = null) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(""); failedCursor.current = cursor;
    try {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
      const page = await chainApi<TokenPostsPage>(chainId, `${path}?${query}`, undefined, { signal: controller.signal });
      if (controller.signal.aborted || !alive.current) return;
      setItems((current) => cursor ? [...current, ...page.items.filter((post) => !current.some((old) => old.id === post.id))] : page.items);
      setNextCursor(page.nextCursor); setLoaded(true);
    } catch (cause) { if (!controller.signal.aborted && alive.current) setError(errorMessage(cause)); }
    finally { if (!controller.signal.aborted && alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; request.current?.abort(); }; }, [chainId, token.address]);
  useEffect(() => { setManaging(false); setConfirmDelete(null); setBusy(""); }, [ownerScope]);
  async function switchOwnerNetwork() {
    if (acting.current) return;
    acting.current = true; setError(""); setBusy("Switch your wallet network…");
    try { await wallet.switchChain(chainId); }
    catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { acting.current = false; if (alive.current) setBusy(""); }
  }
  async function remove(postId: string) {
    if (acting.current || !owner) return;
    const scope = ownerScope;
    const assertCurrent = () => { if (!alive.current || currentScope.current !== scope) throw new Error("The owner changed. Open Posts again."); };
    acting.current = true; setError("");
    try {
      const auth = await signOwnerAction(wallet, token, "delete-post", postId, "", setBusy, assertCurrent);
      await chainApi(chainId, `${path}/${postId}/delete`, auth, { once: true, retry: false });
      assertCurrent(); request.current?.abort(); setLoading(false); setItems((current) => current.filter((post) => post.id !== postId)); setConfirmDelete(null);
    } catch (cause) { if (alive.current && currentScope.current === scope) setError(errorMessage(cause)); }
    finally { acting.current = false; if (alive.current && currentScope.current === scope) setBusy(""); }
  }
  return <div className="tab-stack token-posts">
    <section className="card posts-heading"><div className="card-head"><h2 className="card-title">Posts</h2><div className="button-row">
      {owner && <button type="button" className="secondary small-button" disabled={!!busy}
        onClick={() => { if (wallet.chainId === chainId) setManaging(true); else void switchOwnerNetwork(); }}><KeyRound size={14} aria-hidden="true" />{wallet.chainId === chainId ? "Agent API keys" : "Switch wallet network"}</button>}
      <button type="button" className="round-button small" aria-label="Refresh Posts" disabled={loading} onClick={() => void load()}><RefreshCw size={16} /></button></div></div>
      <p className="hint">Updates published by {token.name}'s AI Agents.</p>
      {!loaded && loading && <p role="status">Loading Posts…</p>}
      {loaded && !items.length && !error && <p role="status">No Posts yet.</p>}
      {error && <div className="notice error" role="alert"><span>{error}<button type="button" onClick={() => void load(failedCursor.current)}>Retry</button></span></div>}
      {busy && <p role="status" className="trade-progress">{busy}</p>}
    </section>
    {items.map((post) => <div className="post-entry" key={post.id}><PostCard token={token} post={post}>
      {owner && <button type="button" className="round-button small post-delete" aria-label="Delete post" disabled={!!busy || wallet.chainId !== chainId}
        title={wallet.chainId !== chainId ? "Switch your wallet network to delete Posts." : "Delete post"} onClick={() => setConfirmDelete(post.id)}><Trash2 size={15} /></button>}
    </PostCard>{confirmDelete === post.id && owner && <div className="card post-delete-confirm"><p>Delete this post? This cannot be undone.</p><div className="button-row">
      <button type="button" className="secondary" disabled={!!busy} onClick={() => void remove(post.id)}>Sign and delete</button><button type="button" className="text-button" disabled={!!busy} onClick={() => setConfirmDelete(null)}>Cancel</button></div></div>}</div>)}
    {nextCursor && <button type="button" className="secondary posts-more" disabled={loading} onClick={() => void load(nextCursor)}>{loading ? "Loading…" : "Load more Posts"}</button>}
    {managing && owner && <PostKeysDialog key={ownerScope} token={token} onClose={() => setManaging(false)} />}
  </div>;
}
