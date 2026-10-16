import { useEffect, useRef, useState } from "react";
import { liveValuesChanged, projectLiveMarket, retainLiveSwaps, type LiveEvent, type LiveProjection, type LiveSwap, type SupplyInfo } from "../lib/musegod-live";
import type { CandleData, ChartInterval, MarketSummary, TradeData } from "../lib/market";
import type { LiveStatus } from "../lib/musegod-live-lifecycle";
import { bankrLive } from "../lib/musegod-live-socket";

export default function MusegodLive(props: { summary: MarketSummary | null; candles: CandleData | null; trades: TradeData | null;
  interval: ChartInterval; info: SupplyInfo | null; onUpdate(value: LiveProjection | null): void }) {
  const current = useRef(props); current.current = props;
  const [swaps, setSwaps] = useState<LiveSwap[]>([]), [price, setPrice] = useState<Extract<LiveEvent, { type: "price" }> | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ connected: false, receiving: false, receivedAt: null });
  const pending = useRef({ swaps, price }), receiving = useRef(false);
  useEffect(() => {
    const unsubscribe = bankrLive.subscribe({ status(next) {
      receiving.current = next.connected && next.receiving; setStatus(next);
    }, event(event) {
      if (event.type === "volume") return false;
      const previous = projectLiveMarket(current.current, pending.current.swaps, pending.current.price);
      if (event.type === "swap") {
        pending.current.swaps = retainLiveSwaps(pending.current.swaps, event, current.current, Date.now());
        setSwaps(pending.current.swaps);
      }
      if (event.type === "price" && (!pending.current.price || Date.parse(event.lastTradeAt) > Date.parse(pending.current.price.lastTradeAt))) {
        pending.current.price = event; setPrice(event);
      }
      const next = projectLiveMarket(current.current, pending.current.swaps, pending.current.price);
      return liveValuesChanged(previous, next) && liveValuesChanged(receiving.current ? previous : current.current, next);
    } });
    return () => { unsubscribe(); current.current.onUpdate(null); };
  }, []);
  useEffect(() => {
    pending.current.swaps = retainLiveSwaps(pending.current.swaps, null, props, Date.now());
    setSwaps(pending.current.swaps);
  }, [props.candles]);
  useEffect(() => {
    props.onUpdate(status.connected && status.receiving ? projectLiveMarket(props, swaps, price) : null);
  }, [props.summary, props.candles, props.trades, props.interval, props.info, props.onUpdate, swaps, price, status]);
  if (!status.connected || !status.receiving || status.receivedAt === null) return null;
  const received = new Date(status.receivedAt).toISOString();
  return <span className="feed-note" role="status">Live · Bankr · Received <time dateTime={received}>{new Date(received).toLocaleTimeString("en-US")}</time></span>;
}
