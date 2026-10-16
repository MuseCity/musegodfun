import { impactText, priceImpact, type ImpactQuote } from "../lib/price-impact";

export function PriceImpactRow({ quote }: { quote: ImpactQuote | null }) {
  const impact = priceImpact(quote);
  return impact && <div className={impact.warning ? "price-impact-warning" : undefined}>
    <dt>Price impact{impact.includesFees ? " (incl. fees)" : ""}</dt>
    <dd title={`Estimated execution impact at block ${quote!.poolPrice!.blockNumber}`}>{impactText(impact.percentMicros)}</dd>
  </div>;
}
export function PriceImpactAcknowledgment({ quote, checked, onChange, disabled }: {
  quote: ImpactQuote | null; checked: boolean; onChange: (checked: boolean) => void; disabled: boolean;
}) {
  const impact = priceImpact(quote);
  return impact?.requiresAcknowledgment && <label className="price-impact-ack">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span>I acknowledge the {impactText(impact.percentMicros)} price impact{impact.includesFees ? " (including fees)" : ""}.</span>
  </label>;
}
