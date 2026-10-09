import { formatUnits, zeroAddress } from "viem";
import { sameAddress } from "../lib/config";
import type { FirstBuyDraft } from "../lib/launch-draft";
import type { FirstBuyPaymentAsset } from "../lib/first-buy-payment";
import { firstBuyUsdReference, usdFirstBuyAmount } from "../lib/first-buy-input";
import { parseAmount } from "../lib/validation";

export default function FirstBuy({ value, asset, assets, balance, price, lockAvailable, busy, error, onChange }: {
  value: FirstBuyDraft; asset: FirstBuyPaymentAsset; assets: FirstBuyPaymentAsset[];
  balance: bigint | null; price: string | null; lockAvailable: boolean; busy: boolean;
  error: string; onChange: (next: FirstBuyDraft) => void;
}) {
  const native = sameAddress(asset.address, zeroAddress);
  let positive = false, usd: string | null = null;
  try {
    const raw = parseAmount(value.amount, asset.decimals); positive = true;
    if (price) usd = firstBuyUsdReference(raw, price, asset.decimals);
  } catch { /* Invalid input is reported by the launch form. */ }
  return <section className="card first-buy-panel" aria-labelledby="first-buy-heading">
    <h2 id="first-buy-heading" className="card-title">Your first buy <span className="optional">(optional)</span></h2>
    <div className={`amount-box${error ? " invalid" : ""}`}>
      <div className="amount-box-head">
        <span>Amount · pay with</span>
        <button type="button" className="first-buy-balance" disabled={busy || balance === null || native}
          title={native ? "ETH maximum is unavailable until gas for the complete launch can be estimated. Keep ETH for network gas." : "Use your available balance"}
          onClick={() => balance !== null && onChange({ ...value, amount: formatUnits(balance, asset.decimals) })}>
          Balance: <span className="mono">{balance === null ? "—" : Number(formatUnits(balance, asset.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} {asset.symbol}</span>
        </button>
      </div>
      <div className="amount-box-main">
        <input id="launch-first-buy" name="firstBuy" aria-label={`First buy amount in ${asset.symbol}`} inputMode="decimal" autoComplete="off"
          aria-invalid={!!error} aria-describedby={error ? "launch-error-firstBuy" : "launch-first-buy-help"}
          disabled={busy} value={value.amount} placeholder="0" onChange={(event) => onChange({ ...value, amount: event.target.value,
            ...(!/[1-9]/.test(event.target.value) ? { lockDays: 0 } : {}) })} />
        <label className="pay-select">
          <span className="visually-hidden">Pay with</span>
          <select aria-label="Pay with" value={asset.address} disabled={busy}
            onChange={(event) => onChange({ ...value, payAddress: event.target.value, amount: "0", lockDays: 0 })}>
            {assets.map((item) => <option key={item.address} value={item.address}>{item.symbol}</option>)}
          </select>
        </label>
      </div>
      <small className="mono" aria-live="polite">{usd ? `≈ $${Number(usd).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : price && !positive ? "≈ $0.00" : "USD estimate unavailable"}</small>
    </div>
    {error && <span className="field-error" id="launch-error-firstBuy" role="alert">{error}</span>}
    <div className="quick-amounts first-buy-shortcuts" role="group" aria-label="First buy USD amount">
      {[10, 20, 50, 100].map((dollars) => <button type="button" key={dollars} disabled={busy || !price}
        onClick={() => { if (price) onChange({ ...value, amount: usdFirstBuyAmount(dollars, price, asset.decimals) }); }}>${dollars}</button>)}
    </div>
    <p className="hint" id="launch-first-buy-help">Leave it at 0 to launch without buying. A different payment asset is converted first; the launch and first buy then execute together.</p>
    {positive && <div className="first-buy-lock">
      <h3 className="field-label">Lock your first buy</h3>
      <div role="group" aria-label="Lock your first buy" className="segmented first-buy-lock-options">
        {([0, 30, 90, 365] as const).map((days) => <button type="button" key={days} disabled={busy || (days > 0 && !lockAvailable)}
          aria-pressed={value.lockDays === days} onClick={() => onChange({ ...value, lockDays: days })}>
          {days === 0 ? "No lock" : days === 365 ? "1 year" : `${days} days`}
        </button>)}
      </div>
      <p className="hint">{value.lockDays === 0 ? "Your tokens arrive in your wallet at launch." :
        `Doppler's Bundler holds your tokens and releases all of them after ${value.lockDays === 365 ? "1 year" : `${value.lockDays} days`}. Buyers can see the lock on-chain.`}</p>
      {!lockAvailable && <p className="hint">Locked first buys are not yet enabled on this network.</p>}
    </div>}
  </section>;
}
