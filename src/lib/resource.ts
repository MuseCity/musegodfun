import { useEffect, useState } from "react";
import { ApiError, chainApi } from "./api";
import { useNetwork } from "./network";
import { nextRecoveryAttempt, type RecoveryBackoff } from "./recovery-backoff";
import { errorMessage } from "./validation";

type ResourceState<T> = { scope: string; data: T | null; error: string; loading: boolean };

export function useResource<T>(path: string, version = 0, { retryOnFailure = false } = {}) {
  const { chainId } = useNetwork();
  const scope = `${chainId}:${path}`;
  const [state, setState] = useState<ResourceState<T>>(() => ({ scope, data: null, error: "", loading: true }));
  useEffect(() => {
    let active = true;
    let backoff: RecoveryBackoff | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // A refresh keeps the confirmed data; a new chain or path starts empty.
    setState((previous) => previous.scope === scope ? { ...previous, error: "", loading: true } : { scope, data: null, error: "", loading: true });
    async function read() {
      try {
        const data = await chainApi<T>(chainId, path);
        if (active) setState({ scope, data, error: "", loading: false });
      } catch (error) {
        if (!active) return;
        setState((previous) => ({ scope, data: previous.scope === scope ? previous.data : null, error: errorMessage(error), loading: false }));
        if (!retryOnFailure) return;
        if (error instanceof ApiError && error.status < 500 && error.status !== 408 && error.status !== 429) return;
        const now = Date.now();
        backoff = nextRecoveryAttempt(backoff, error, now);
        retryTimer = setTimeout(() => {
          setState((previous) => ({ ...previous, loading: true }));
          void read();
        }, backoff.nextAt - now);
      }
    }
    void read();
    return () => {
      active = false;
      clearTimeout(retryTimer);
    };
  }, [path, version, chainId, retryOnFailure]);
  // Until the effect runs for a newly selected chain or path, never expose the previous scope's result.
  return state.scope === scope ? { data: state.data, error: state.error, loading: state.loading } : { data: null, error: "", loading: true };
}
