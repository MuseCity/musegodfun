import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { deploymentChain, type TokenRecord } from "./config";
import { api } from "./api";
import type { RuntimeConfig } from "./config";

export type DeploymentChainId = 8453 | 4663;
export function pathChain(path = location.pathname, search = location.search): DeploymentChainId | null {
  if (path.startsWith("/token/base/")) return 8453;
  if (path.startsWith("/token/robinhood/") || path.startsWith("/token/") || path === "/buyback") return 4663;
  const query = new URLSearchParams(search).get("chainId");
  return query === "8453" ? 8453 : query === "4663" ? 4663 : null;
}
export function tokenPath(token: Pick<TokenRecord, "address" | "mode" | "deploymentChainId">) {
  return `/token/${deploymentChain(token) === 8453 ? "base" : "robinhood"}/${token.address}`;
}
const Network = createContext<{ chainId: DeploymentChainId; selectChain: (id: DeploymentChainId) => void } | null>(null);
export function NetworkProvider({ children }: { children: ReactNode }) {
  const [chainId, setChainId] = useState<DeploymentChainId>(() => typeof location === "undefined" ? 4663 : pathChain() ?? 4663);
  const revision = useRef(0);
  useEffect(() => {
    const update = () => { revision.current++; const next = pathChain(); if (next) setChainId(next); };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    if (pathChain() !== null) return;
    let active = true;
    const request = revision.current;
    void api<RuntimeConfig>("/config").then((config) => {
      if (active && revision.current === request && config.mode === "fork" && pathChain() === null) setChainId(deploymentChain(config));
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  function selectChain(id: DeploymentChainId) {
    if (![8453, 4663].includes(id)) throw new Error("Unsupported network");
    revision.current++;
    const url = new URL(location.href);
    if (url.pathname.startsWith("/token/") || url.pathname === "/buyback") url.pathname = "/create";
    url.searchParams.set("chainId", String(id));
    history.pushState({}, "", `${url.pathname}${url.search}`);
    setChainId(id);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  return <Network.Provider value={{ chainId, selectChain }}>{children}</Network.Provider>;
}
export function useNetwork() {
  const value = useContext(Network);
  if (!value) throw new Error("NetworkProvider is missing");
  return value;
}
