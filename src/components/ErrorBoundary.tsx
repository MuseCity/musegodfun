import { Component, type ReactNode } from "react";
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="panel">
        <h1>This page is temporarily unavailable</h1>
        <p>Broadcast transactions are unaffected. Reload to resume checking them in your wallet transaction history.</p>
        <button onClick={() => location.reload()}>Reload</button>
        <a href="/">Back to home</a>
      </main>
    ) : (
      this.props.children
    );
  }
}
