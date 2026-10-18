import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

/** An info icon whose text shows while a mouse is over the icon or the text, while the icon has keyboard focus, or after a tap (touch
 * screens have no hover; a second tap or a tap elsewhere closes it). While it shows, the first Escape hides it and goes no further, so
 * a surrounding dialog stays open. The text stays in the page as the button's description, so screen readers read it without opening
 * it; it takes no space while hidden. */
export default function InfoTip({ id, label, text }: { id: string; label: string; text: string }) {
  const [open, setOpen] = useState(false), [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const shown = (open || hovered || focused) && !dismissed;
  useEffect(() => {
    if (!shown) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); setDismissed(true);
    };
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const capture = { capture: true };
    document.addEventListener("keydown", escape, capture); document.addEventListener("pointerdown", outside, capture);
    return () => { document.removeEventListener("keydown", escape, capture); document.removeEventListener("pointerdown", outside, capture); };
  }, [shown]);
  const mouse = (event: { pointerType: string }) => event.pointerType === "mouse";
  return (
    <span ref={root} className="info-tip" data-shown={shown ? "true" : undefined}
      onPointerEnter={(event) => { if (mouse(event)) { setHovered(true); setDismissed(false); } }}
      onPointerLeave={(event) => { if (mouse(event)) { setHovered(false); setDismissed(false); } }}>
      <button type="button" className="info-tip-button" aria-label={label} aria-describedby={id}
        onClick={() => { setDismissed(false); setOpen((value) => !value); }}
        onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible"))}
        onBlur={() => { setFocused(false); setOpen(false); setDismissed(false); }}>
        <Info size={14} aria-hidden="true" />
      </button>
      <span role="tooltip" id={id} className="info-tip-text">{text}</span>
    </span>
  );
}
