import { ErrorBoundary } from "./components/ErrorBoundary";
import React from "react";
import ReactDOM from "react-dom/client";
import { WalletProvider } from "./lib/wallet";
import { App } from "./App";
import { NetworkProvider } from "./lib/network";
import "./styles.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <NetworkProvider><WalletProvider>
        <App />
      </WalletProvider></NetworkProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
