import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Copy, Gem } from "lucide-react";
import type { Address } from "viem";
import { chainApi } from "../lib/api";
import { deploymentChain, shortAddress, type RuntimeConfig, type TokenRecord } from "../lib/config";
import { isMuse, nftKey, type NftRef } from "../lib/nft-mode";
import { NFT_OWNER_SCAN_LIMIT, heldNftCoins, listedNftCoin } from "../lib/nft-treasury";
import { nftPath, tokenPath } from "../lib/network";
import { errorMessage } from "../lib/validation";
import { transactionClient, useWallet } from "../lib/wallet";
import { NftTreasuryCard, nftQuery } from "./NftCoinCard";
import { NftBadge } from "./TokenCard";

function PageLink({ href, navigate, className, children }: { href: string; navigate: (path: string) => void; className?: string; children: ReactNode }) {
  return <a href={href} className={className} onClick={(event) => {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); navigate(href); }
  }}>{children}</a>;
}
const nftName = (nft: NftRef) => isMuse(nft) ? `Muse #${nft.tokenId}` : `NFT #${nft.tokenId}`;

/** `/nft/:chain/:contract/:id`: the NFT's listed coins (verified and unverified; never rejected or hidden) and its treasury. */
export default function NftPage({ nft, config, navigate }: { nft: NftRef; config: RuntimeConfig | null; navigate: (path: string) => void }) {
  const key = nftKey(nft);
  const [coins, setCoins] = useState<TokenRecord[] | null>(null), [coinsError, setCoinsError] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let active = true;
    setCoins(null); setCoinsError("");
    chainApi<TokenRecord[]>(nft.chainId, `/tokens?nft=${nftQuery(nft)}`)
      .then((rows) => { if (active) setCoins(rows.filter((row) => row.nftVerification?.status !== "rejected" && !row.hidden)); },
        (cause) => { if (active) setCoinsError(errorMessage(cause)); });
    return () => { active = false; };
  }, [key]);
  function copyLink() {
    void navigator.clipboard.writeText(`${location.origin}${nftPath(nft)}`)
      .then(() => setCopied("Link copied. Paste it into your marketplace listing."), () => setCopied("Copy failed. Copy the address bar instead."));
  }
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">NFT treasury</span>
        <h1 className="page-title">{nftName(nft)}</h1>
        <p className="page-lede">Coins bound to this NFT send their creator fees to its treasury. Whoever holds the NFT controls the treasury, so the fees follow the NFT when it is sold.</p>
        <div className="button-row">
          <button type="button" className="secondary" onClick={copyLink}><Copy size={16} aria-hidden="true" />Copy link for your marketplace listing</button>
        </div>
        <p className="hint" role="status" aria-live="polite">{copied}</p>
      </div>
      <section className="card" aria-labelledby={`nft-coins-${key}`}>
        <h2 id={`nft-coins-${key}`} className="card-title"><Gem size={18} aria-hidden="true" />Coins for this NFT {coins && <span className="count">{coins.length}</span>}</h2>
        {coinsError ? <div className="notice error" role="alert"><span>The coins could not be loaded: {coinsError}</span></div>
          : !coins ? <p className="hint" role="status">Loading coins…</p>
          : coins.length ? <ul className="nft-coin-list">{coins.map((coin) => <li key={coin.address}>
            <PageLink href={tokenPath(coin)} navigate={navigate} className="token-name">{coin.name}</PageLink>
            <span className="mono hint">${coin.symbol} · {shortAddress(coin.address)}</span>
            <NftBadge token={coin} />
          </li>)}</ul>
          : <p className="hint">No listed coin is bound to this NFT yet.</p>}
      </section>
      {!config ? <p className="hint" role="status">Loading the network…</p>
        : deploymentChain(config) !== nft.chainId ? <div className="notice error" role="alert"><span>This NFT lives on another network.</span></div>
        : <NftTreasuryCard config={config} nft={nft} coins={coins ?? []} />}
    </>
  );
}

/** Rewards: the NFTs this wallet holds among the listed NFT coins (not rejected, not hidden), read with one `ownerOf` multicall over the first 200. */
export function MyNftTreasuries({ tokens, config, navigate }: { tokens: TokenRecord[]; config: RuntimeConfig | null; navigate: (path: string) => void }) {
  const wallet = useWallet(), account = wallet.account;
  const [result, setResult] = useState<{ held: { nft: NftRef; coins: TokenRecord[] }[]; capped: boolean } | null>(null), [error, setError] = useState("");
  const nftCoins = tokens.filter(listedNftCoin);
  const scope = nftCoins.slice(0, NFT_OWNER_SCAN_LIMIT).map((token) => `${token.address}:${nftKey(token.nft!)}`).join(",");
  useEffect(() => {
    let active = true;
    setResult(null); setError("");
    if (!account || !config || !scope) return;
    heldNftCoins(transactionClient(config.chainId, config), nftCoins, account as Address)
      .then((next) => { if (active) setResult(next); }, (cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [account, scope, config?.chainId, config?.deploymentChainId]);
  if (!account || !nftCoins.length) return null;
  return (
    <section className="rewards-list" aria-labelledby="nft-treasuries-title">
      <div className="section-heading">
        <h2 id="nft-treasuries-title" className="serif-title">My NFT treasuries {result && <span className="count">{result.held.length}</span>}</h2>
      </div>
      <p className="hint">Creator fees of NFT coins go to the NFT's treasury, which its holder controls.</p>
      {error ? <div className="notice error" role="alert"><span>NFT holders could not be read: {error}</span></div>
        : !result ? <p className="hint" role="status">Checking which NFTs this wallet holds…</p>
        : result.held.length ? <ul className="nft-coin-list">{result.held.map(({ nft, coins }) => <li key={nftKey(nft)}>
          <PageLink href={nftPath(nft)} navigate={navigate} className="token-name">{nftName(nft)}</PageLink>
          <span className="hint">{coins.map((coin) => `$${coin.symbol}`).join(", ")}</span>
          <PageLink href={nftPath(nft)} navigate={navigate} className="text-button">Open treasury <ArrowRight size={14} aria-hidden="true" /></PageLink>
        </li>)}</ul>
        : <p className="hint">This wallet holds none of the NFTs behind the loaded coins.</p>}
      {result?.capped && <p className="hint">Only the first {NFT_OWNER_SCAN_LIMIT} NFT coins were checked.</p>}
    </section>
  );
}
