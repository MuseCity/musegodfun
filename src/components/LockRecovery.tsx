import { useState } from "react";
import { LockKeyhole } from "lucide-react";
import { isAddress, type Address } from "viem";
import FirstBuyLock from "./FirstBuyLock";
import { deploymentChain, sameAddress, shortAddress, type RuntimeConfig } from "../lib/config";
import { transactions, transactionMatchesConfig } from "../lib/transactions";
export default function LockRecovery({ config }: { config: RuntimeConfig | null }) {
  const [input, setInput] = useState(""), [address, setAddress] = useState<Address | null>(null), [error, setError] = useState("");
  if (!config) return null;
  const choices = [...new Set(transactions().filter((row) => row.action === "launch" && row.tokenAddress && transactionMatchesConfig(row, config)).map((row) => row.tokenAddress!))];
  return <section className="card lock-recovery" aria-labelledby="lock-recovery-title">
    <div>
      <h2 id="lock-recovery-title" className="card-title"><LockKeyhole size={18} />Find a locked first buy</h2>
      <p className="card-sub">Choose a launch from this browser or enter its token address. Catalog registration is not required.</p>
    </div>
    <form className="lock-form" onSubmit={(event) => { event.preventDefault(); if (!isAddress(input, { strict: false })) { setError("Enter a valid token contract address."); return; } setError(""); setAddress(input as Address); }}>
      <label className="field" htmlFor="lock-token"><span className="field-label">Token address</span></label>
      <div className="lock-input">
        <input id="lock-token" className="mono" value={input} onChange={(event) => setInput(event.target.value)} list="lock-history" placeholder="0x…" />
        <button className="secondary" type="submit">Check lock</button>
      </div>
      <datalist id="lock-history">{choices.map((value) => <option key={value} value={value} />)}</datalist>
      {error && <p role="alert" className="field-error">{error}</p>}
    </form>
    {choices.length > 0 && <div className="lock-choices">
      <span className="hint">From this browser</span>
      {choices.slice(0, 6).map((value) => <button type="button" key={value} className="filter-chip" aria-pressed={!!address && sameAddress(address, value)}
        onClick={() => { setInput(value); setError(""); setAddress(value as Address); }}><span className="mono">{shortAddress(value)}</span></button>)}
    </div>}
    {address && <FirstBuyLock tokenAddress={address} deploymentChainId={deploymentChain(config)} config={config} nested />}
  </section>;
}
