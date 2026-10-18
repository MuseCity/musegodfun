import { useState } from "react";
import { Info } from "lucide-react";

/** An info icon whose text shows on hover, on keyboard focus and on tap (touch screens have no hover). A second tap closes it; Escape
 * hides it first and only then reaches the surrounding dialog. The text stays in the page as the button's description, so screen
 * readers read it without opening it. */
export default function InfoTip({ id, label, text }: { id: string; label: string; text: string }) {
  const [open, setOpen] = useState(false), [dismissed, setDismissed] = useState(false);
  return (
    <span className="info-tip" data-open={open ? "true" : undefined} data-dismissed={dismissed ? "true" : undefined}
      onMouseLeave={() => setDismissed(false)}>
      <button type="button" className="info-tip-button" aria-label={label} aria-describedby={id}
        onClick={() => { setDismissed(false); setOpen((value) => !value); }}
        onBlur={() => { setOpen(false); setDismissed(false); }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || dismissed) return;
          event.preventDefault(); event.stopPropagation(); setOpen(false); setDismissed(true);
        }}>
        <Info size={14} aria-hidden="true" />
      </button>
      <span role="tooltip" id={id} className="info-tip-text">{text}</span>
    </span>
  );
}
