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
      <main className="page">
        <section className="card not-found">
          <h1 className="page-title">This page is temporarily unavailable</h1>
          <p className="muted">Broadcast transactions are unaffected. Reload to resume checking them in your wallet transaction history.</p>
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => location.reload()}>Reload</button>
            <a href="/" className="text-button">Back to home</a>
          </div>
        </section>
      </main>
    ) : (
      this.props.children
    );
  }
}
