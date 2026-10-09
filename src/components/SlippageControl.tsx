const OPTIONS = [50, 100, 200, 500] as const;

export default function SlippageControl({ value, disabled, onChange }: {
  value: number;
  disabled?: boolean;
  onChange: (bps: number) => void;
}) {
  return <div className="slippage-row">
    <span id="trade-slippage-label">Maximum slippage</span>
    <div className="segmented mono compact" role="radiogroup" aria-label="Maximum trade slippage">
      {OPTIONS.map((bps, index) => <button type="button" role="radio" key={bps} aria-checked={value === bps}
        tabIndex={value === bps ? 0 : -1} disabled={disabled} onClick={() => onChange(bps)}
        onKeyDown={(event) => {
          const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length];
          onChange(next);
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[OPTIONS.indexOf(next)]?.focus();
        }}>{bps / 100}%</button>)}
    </div>
  </div>;
}
