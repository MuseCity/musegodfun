import { useEffect, useRef, useState } from "react";
import { chainApi } from "./api";
import { useNetwork } from "./network";
import type { TokenRecord } from "./config";
export type TokenPage = { items: TokenRecord[]; nextCursor: string | null };
export function useTokenCatalog(version = 0) {
  const { chainId } = useNetwork();
  const [data, setData] = useState<TokenRecord[] | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [nextCursor, setNextCursor] = useState<string | null>(null);
  const request = useRef(0), loadingPage = useRef(false), activeChain = useRef(chainId);
  async function read(cursor?: string) {
    if (loadingPage.current) return;
    loadingPage.current = true; setLoading(true);
    const generation = request.current, selected = chainId;
    try {
      const page = await chainApi<TokenPage | TokenRecord[]>(selected, `/tokens?limit=50${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
      if (generation !== request.current || activeChain.current !== selected) return;
      const rows = Array.isArray(page) ? page : page.items;
      setData((previous) => cursor ? [...new Map([...(previous ?? []), ...rows].map((row) => [row.address.toLowerCase(), row])).values()] : rows);
      setNextCursor(Array.isArray(page) ? null : page.nextCursor); setError("");
    } catch (cause) { if (generation === request.current) setError(cause instanceof Error ? cause.message : "The catalog could not be loaded."); }
    finally { if (generation === request.current) { setLoading(false); loadingPage.current = false; } }
  }
  useEffect(() => {
    request.current++; loadingPage.current = false;
    if (activeChain.current !== chainId) { activeChain.current = chainId; setData(null); setNextCursor(null); }
    void read();
    return () => { request.current++; loadingPage.current = false; };
  }, [chainId, version]);
  return { data, error, loading, nextCursor, loadMore: () => nextCursor && void read(nextCursor) };
}
