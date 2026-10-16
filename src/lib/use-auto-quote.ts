import { useEffect, useRef, useState } from "react";
import { createAutoQuoteScheduler, type AutoQuoteInput, type AutoQuoteRequestOptions } from "./auto-quote";

export function useAutoQuote<T>(input: Omit<AutoQuoteInput, "visible">, callbacks: {
  request: (options: AutoQuoteRequestOptions) => Promise<T>; remaining: (quote: T) => number; result: (quote: T) => void; error: (error: unknown) => void;
}) {
  const latest = useRef(callbacks); latest.current = callbacks;
  const [pending, setPending] = useState(false), [manual, setManual] = useState(false);
  const [visible, setVisible] = useState(() => typeof document !== "undefined" && document.visibilityState !== "hidden");
  const scheduler = useRef<ReturnType<typeof createAutoQuoteScheduler<T>> | null>(null);
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    scheduler.current = createAutoQuoteScheduler<T>({ request: options => latest.current.request(options), remaining: q => latest.current.remaining(q),
      result: q => latest.current.result(q), error: e => latest.current.error(e), pending: setPending, manual: setManual });
    return () => { document.removeEventListener("visibilitychange", change); scheduler.current?.dispose(); scheduler.current = null; };
  }, []);
  useEffect(() => { scheduler.current?.update({ ...input, visible }); },
    [input.key, input.lifi, input.valid, input.pool, input.busy, input.completed, input.connected, visible]);
  return { pending, manual, refresh: () => scheduler.current?.refresh() };
}
