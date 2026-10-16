import { useEffect, useRef, useState } from "react";
import { projectLiveMarket, retainLiveSwaps, type LiveEvent, type LiveProjection, type LiveSwap, type SupplyInfo } from "../lib/musegod-live";
import type { CandleData, ChartInterval, MarketSummary, TradeData } from "../lib/market";
import type { LiveStatus } from "../lib/musegod-live-lifecycle";
import { bankrLive } from "../lib/musegod-live-socket";

export default function MusegodLive(props: { summary: MarketSummary | null; candles: CandleData | null; trades: TradeData | null;
  interval: ChartInterval; info: SupplyInfo | null; onUpdate(value: LiveProjection | null): void }) {
  const current = useRef(props); current.current = props;
  const [swaps, setSwaps] = useState<LiveSwap[]>([]), [price, setPrice] = useState<Extract<LiveEvent, { type: "price" }> | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ connected: false, receiving: false, receivedAt: null });
  useEffect(() => {
    const unsubscribe = bankrLive.subscribe({ status: setStatus, event(event) {
      if (event.type === "swap") setSwaps(previous => retainLiveSwaps(previous, event, current.current, Date.now()));
      if (event.type === "price") setPrice(previous => !previous || Date.parse(event.lastTradeAt) > Date.parse(previous.lastTradeAt) ? event : previous);
    } });
    return () => { unsubscribe(); current.current.onUpdate(null); };
  }, []);
  useEffect(() => {
    setSwaps(previous => retainLiveSwaps(previous, null, props, Date.now()));
  }, [props.candles]);
  useEffect(() => {
    props.onUpdate(status.connected && status.receiving ? projectLiveMarket(props, swaps, price) : null);
  }, [props.summary, props.candles, props.trades, props.interval, props.info, props.onUpdate, swaps, price, status]);
  if (!status.connected || !status.receiving || status.receivedAt === null) return null;
  const received = new Date(status.receivedAt).toISOString();
  return <span className="feed-note" role="status">Live · Bankr · Received <time dateTime={received}>{new Date(received).toLocaleTimeString("en-US")}</time></span>;
}
