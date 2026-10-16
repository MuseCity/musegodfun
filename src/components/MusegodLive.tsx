import { useEffect, useRef, useState } from "react";
import { liveValuesChanged, newerPrice, projectLiveMarket, retainLiveSwaps, type LiveEvent, type LiveProjection, type LiveSwap, type SupplyInfo } from "../lib/musegod-live";
import type { CandleData, ChartInterval, MarketSummary, TradeData } from "../lib/market";
import type { LiveStatus } from "../lib/musegod-live-lifecycle";
import { bankrLive } from "../lib/musegod-live-socket";

export default function MusegodLive(props: { summary: MarketSummary | null; candles: CandleData | null; trades: TradeData | null;
  interval: ChartInterval; info: SupplyInfo | null; onUpdate(value: LiveProjection | null): void }) {
  const current = useRef(props); current.current = props;
  const [swaps, setSwaps] = useState<LiveSwap[]>([]), [price, setPrice] = useState<Extract<LiveEvent, { type: "price" }> | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ connected: false, receiving: false, receivedAt: null });
  const pending = useRef({ swaps, price });
  useEffect(() => {
    const unsubscribe = bankrLive.subscribe({ status: setStatus, event(event) {
      if (event.type === "volume") return false;
      const previous = projectLiveMarket(current.current, pending.current.swaps, pending.current.price);
      if (event.type === "swap") {
        pending.current.swaps = retainLiveSwaps(pending.current.swaps, event, current.current, Date.now());
        setSwaps(pending.current.swaps);
      }
      if (event.type === "price" && newerPrice(pending.current.price, event)) { pending.current.price = event; setPrice(event); }
      // What is displayed is always the previous projection, so only a visible change renews the Live window.
      return liveValuesChanged(previous, projectLiveMarket(current.current, pending.current.swaps, pending.current.price));
    } });
    return () => { unsubscribe(); current.current.onUpdate(null); };
  }, []);
  // Each REST section releases swaps on its own evidence, so any of them refreshing can release some.
  useEffect(() => {
    const kept = retainLiveSwaps(pending.current.swaps, null, props, Date.now());
    if (kept.length !== pending.current.swaps.length) { pending.current.swaps = kept; setSwaps(kept); }
  }, [props.candles, props.summary, props.trades]);
  // Only the label expires with the receipt window: the newest known value stays until REST catches up or the connection ends.
  useEffect(() => {
    props.onUpdate(status.connected && (swaps.length > 0 || price !== null) ? projectLiveMarket(props, swaps, price) : null);
  }, [props.summary, props.candles, props.trades, props.interval, props.info, props.onUpdate, swaps, price, status]);
  if (!status.connected || !status.receiving || status.receivedAt === null) return null;
  const received = new Date(status.receivedAt).toISOString();
  return <span className="feed-note" role="status">Live · Bankr · Received <time dateTime={received}>{new Date(received).toLocaleTimeString("en-US")}</time></span>;
}
