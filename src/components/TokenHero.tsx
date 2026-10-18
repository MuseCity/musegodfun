import type { ReactNode } from "react";
import { ArrowDown, ArrowUpRight, PencilLine, Share2 } from "lucide-react";
import type { ProfileField } from "../lib/token-profile";

export type HeroStat = { label: string; value: string; hint?: string };
/** The token page header (tasks/token-ip-detail-plan.md §3): identity, social links and a band of facts the page already holds. */
export default function TokenHero({ icon, overline, name, symbol, badges, story, meta, links, extraLinks, onShare, onEdit, onTrade, figure, stats }: {
  icon: ReactNode;
  overline: string;
  name: string;
  symbol: string;
  badges: ReactNode;
  story: string;
  meta: ReactNode;
  links: { field: ProfileField; href: string; label: string }[];
  /** Links that are not social channels (OpenSea for an NFT coin). */
  extraLinks?: { href: string; label: string }[];
  onShare: () => void;
  /** Present only for the profile owner. */
  onEdit?: () => void;
  /** Moves to the trade card; the button shows only while the columns stack, when the card sits below the tabs. */
  onTrade?: () => void;
  figure: { label: string; value: string; note: string } | null;
  stats: HeroStat[];
}) {
  return (
    <header className="card token-hero" aria-labelledby="token-title">
      <div className="token-hero-main">
        {icon}
        <div className="token-hero-identity">
          <span className="eyebrow">{overline}</span>
          <div className="token-hero-title">
            <h1 id="token-title">{name}</h1>
            <span className="mono token-hero-symbol">${symbol}</span>
            {badges}
          </div>
          {story && <p className="token-hero-story">{story}</p>}
          <div className="token-hero-meta">{meta}</div>
          <div className="token-hero-links">
            {links.map((link) => <a key={link.field} className="secondary small-button" href={link.href} target="_blank" rel="noopener noreferrer">
              <span>{link.label}</span> <ArrowUpRight size={14} aria-hidden="true" /></a>)}
            {extraLinks?.map((link) => <a key={link.href} className="secondary small-button" href={link.href} target="_blank" rel="noopener noreferrer">
              <span>{link.label}</span> <ArrowUpRight size={14} aria-hidden="true" /></a>)}
            {onTrade && <button type="button" className="primary small-button token-hero-trade" onClick={onTrade}>Trade ${symbol} <ArrowDown size={14} aria-hidden="true" /></button>}
            <button type="button" className="text-button" onClick={onShare}><Share2 size={14} aria-hidden="true" />Share</button>
            {onEdit && <button type="button" className="text-button" onClick={onEdit}><PencilLine size={14} aria-hidden="true" />Edit profile</button>}
          </div>
        </div>
        {figure && <div className="token-hero-figure">
          <span className="eyebrow muted">{figure.label}</span>
          <span className="mono">{figure.value}</span>
          <span className="hint">{figure.note}</span>
        </div>}
      </div>
      {stats.length > 0 && <dl className="token-hero-stats" aria-label="Key facts">
        {stats.map((stat) => <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value}{stat.hint && <small> {stat.hint}</small>}</dd></div>)}
      </dl>}
    </header>
  );
}
