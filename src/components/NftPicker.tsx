import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import type { RuntimeConfig } from "../lib/config";
import { filterCollections, nftTokensMatch, type OwnedCollection, type OwnedCollections, type OwnedNfts } from "../lib/nft-holdings";
import { readNftCollections, readNftTokens } from "../lib/nft-client";

export type NftPick = { contract: Address; tokenId: string; name?: string; image?: string };
type Load<T> = { state: "loading" } | { state: "error" } | { state: "ready"; value: T };
const TRUNCATED = "Showing the first 300. Use manual entry for others.";

export function Thumb({ src, size }: { src?: string; size: number }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <span className="nft-thumb nft-thumb-empty" style={{ width: size, height: size }} aria-hidden="true" />;
  return <img className="nft-thumb" src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

/** Step one's list of what the connected wallet holds: its ERC-721 collections, then one collection's NFTs. Every answer is tied to the
 * account, collection and attempt it was asked for, so a wallet switch never shows another account's NFTs. */
export function NftPicker({ config, account, connecting, onConnect, onPick, onManual, focusSearch, onSearchFocused }: {
  config: RuntimeConfig; account: Address | null; connecting: boolean; onConnect: () => void; onPick: (pick: NftPick) => void; onManual: () => void;
  focusSearch: boolean; onSearchFocused: () => void;
}) {
  const [collections, setCollections] = useState<Load<OwnedCollections>>({ state: "loading" });
  const [open, setOpen] = useState<OwnedCollection | null>(null);
  const [tokens, setTokens] = useState<Load<OwnedNfts>>({ state: "loading" });
  const search = useRef<HTMLInputElement>(null), heading = useRef<HTMLHeadingElement>(null), listStatus = useRef<HTMLParagraphElement>(null);
  // Separate retry counters: retrying one collection's NFTs must not close that collection or reload the collection list.
  const [query, setQuery] = useState(""), [listAttempt, setListAttempt] = useState(0), [tokenAttempt, setTokenAttempt] = useState(0);
  useEffect(() => {
    if (!account) return;
    let active = true;
    setCollections({ state: "loading" });
    readNftCollections(config, account).then((value) => { if (active) setCollections({ state: "ready", value }); },
      () => { if (active) setCollections({ state: "error" }); });
    return () => { active = false; };
  }, [account, config.chainId, config.deploymentChainId, listAttempt]);
  useEffect(() => {
    if (!account || !open) return;
    let active = true;
    setTokens({ state: "loading" });
    readNftTokens(config, account, open.contract).then((value) => { if (active) setTokens({ state: "ready", value }); },
      () => { if (active) setTokens({ state: "error" }); });
    return () => { active = false; };
  }, [account, open?.contract, config.chainId, config.deploymentChainId, tokenAttempt]);
  // Only an explicit return requests focus; on settle, leave focus alone if the person moved on.
  useEffect(() => {
    if (!focusSearch) return;
    if (account && collections.state === "loading") { listStatus.current?.focus(); return; }
    if (document.activeElement === document.body || document.activeElement === listStatus.current) {
      (search.current ?? listStatus.current)?.focus();
    }
    onSearchFocused();
  }, [account, collections.state, focusSearch, onSearchFocused]);

  const manual = <button type="button" className="text-button" onClick={onManual}>Enter a contract and token number instead</button>;
  if (!account) return <div className="nft-picker">
    <p ref={listStatus} tabIndex={-1}>Connect your wallet to see your NFTs.</p>
    <button type="button" className="primary" disabled={connecting} onClick={onConnect}>{connecting ? "Connecting…" : "Connect wallet"}</button>
    {manual}
  </div>;
  const failed = (retry: () => void) => <div className="nft-picker-note" role="alert">
    <p ref={listStatus} tabIndex={-1}>Couldn't load your NFTs.</p><button type="button" className="secondary" onClick={retry}>Retry</button>{manual}
  </div>;
  if (collections.state === "loading") return <div className="nft-picker"><p ref={listStatus} role="status" tabIndex={-1}>Loading your NFTs…</p>{manual}</div>;
  if (collections.state === "error") return <div className="nft-picker">{failed(() => setListAttempt((n) => n + 1))}</div>;

  if (open) return <div className="nft-picker">
    <button type="button" className="text-button" onClick={() => { setOpen(null); requestAnimationFrame(() => search.current?.focus()); }}>← All collections</button>
    <h3 ref={heading} className="field-label" tabIndex={-1}>{open.name}</h3>
    {tokens.state === "loading" || tokens.state === "ready" && !nftTokensMatch(tokens.value, account, open.contract) ? <p role="status">Loading your NFTs…</p>
      : tokens.state === "error" ? failed(() => setTokenAttempt((n) => n + 1))
      : <>
        <ul className="nft-token-grid" role="list">
          {tokens.value.tokens.map((token) => <li key={token.tokenId}>
            <button type="button" className="nft-token-tile" disabled={token.launched}
              aria-label={`${token.name ?? `#${token.tokenId}`}${token.launched ? ", already launched" : ""}`}
              onClick={() => onPick({ contract: open.contract, tokenId: token.tokenId, name: token.name, image: token.image })}>
              <Thumb src={token.image} size={120} />
              <span className="nft-token-name">{token.name ?? `#${token.tokenId}`}</span>
              {token.launched && <span className="nft-pick-badge">Already launched</span>}
            </button>
          </li>)}
        </ul>
        {tokens.value.truncated && <p className="hint nft-picker-truncated">{TRUNCATED}</p>}
      </>}
    {manual}
  </div>;

  const shown = filterCollections(collections.value.collections, query);
  return <div className="nft-picker">
    {collections.value.collections.length === 0 ? <p ref={listStatus} tabIndex={-1}>No NFTs found in this wallet on Robinhood Chain.</p> : <>
      <label className="field">
        <span className="field-label">Search your collections</span>
        <input ref={search} type="search" aria-label="Search your collections" value={query} autoComplete="off" spellCheck={false}
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
          onChange={(event) => setQuery(event.target.value)} />
      </label>
      <ul className="nft-collection-list" role="list">
        {shown.map((collection) => <li key={collection.contract}>
          <button type="button" className="nft-collection-row" onClick={() => { setOpen(collection); requestAnimationFrame(() => heading.current?.focus()); }}>
            <Thumb src={collection.image} size={40} />
            <span className="nft-collection-text">
              <span className="nft-collection-name">{collection.name}</span>
              <span className="hint">{collection.held} held</span>
            </span>
            <span className="nft-badges">
              <span className="nft-pick-badge">{collection.free ? "Free" : "$10"}</span>
              {collection.openSeaVerified && <span className="nft-pick-badge">Verified on OpenSea</span>}
            </span>
          </button>
        </li>)}
      </ul>
      {shown.length === 0 && <p>No collections match.</p>}
      {collections.value.truncated && <p className="hint nft-picker-truncated">{TRUNCATED}</p>}
    </>}
    {manual}
  </div>;
}
