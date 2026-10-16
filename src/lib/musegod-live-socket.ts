import { io } from "socket.io-client";
import { createLiveConnection } from "./musegod-live-lifecycle";

// This module and its dependency are reachable only through the MUSEGOD lazy component.
export const bankrLive = createLiveConnection({
  createSocket: () => io("wss://api.bankr.bot/pools-fun", {
    transports: ["websocket"], path: "/socket.io/", reconnection: false, timeout: 15_000, withCredentials: false,
  }),
  visible: () => document.visibilityState === "visible",
  watchVisibility: fn => { document.addEventListener("visibilitychange", fn); return () => document.removeEventListener("visibilitychange", fn); },
});
