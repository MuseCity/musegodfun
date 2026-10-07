import { useState } from "react";
import { isAddress, type Address } from "viem";
import FirstBuyLock from "./FirstBuyLock";
import { deploymentChain, type RuntimeConfig } from "../lib/config";
import { transactions, transactionMatchesConfig } from "../lib/transactions";
export default function LockRecovery({ config }: { config: RuntimeConfig | null }) {
  const [input, setInput] = useState(""), [address, setAddress] = useState<Address | null>(null), [error, setError] = useState("");
  if (!config) return null;
  const choices = [...new Set(transactions().filter((row) => row.action === "launch" && row.tokenAddress && transactionMatchesConfig(row, config)).map((row) => row.tokenAddress!))];
  return <details className="panel"><summary>Find a locked first buy</summary>
    <p>Choose a launch from this browser or enter its token address. Catalog registration is not required.</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!isAddress(input, { strict: false })) { setError("Enter a valid token contract address."); return; } setError(""); setAddress(input as Address); }}>
      <label htmlFor="lock-token">Token address</label><input id="lock-token" value={input} onChange={(event) => setInput(event.target.value)} list="lock-history" placeholder="0x…" />
      <datalist id="lock-history">{choices.map((value) => <option key={value} value={value} />)}</datalist>
      <button className="secondary" type="submit">Check lock</button>{error && <p role="alert">{error}</p>}
    </form>
    {address && <FirstBuyLock tokenAddress={address} deploymentChainId={deploymentChain(config)} config={config} />}
  </details>;
}
