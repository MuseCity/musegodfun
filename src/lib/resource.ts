import { useEffect, useState } from "react";
import { chainApi } from "./api";
import { useNetwork } from "./network";
import { errorMessage } from "./validation";

type ResourceState<T> = { scope: string; data: T | null; error: string; loading: boolean };

export function useResource<T>(path: string, version = 0) {
  const { chainId } = useNetwork();
  const scope = `${chainId}:${path}`;
  const [state, setState] = useState<ResourceState<T>>(() => ({ scope, data: null, error: "", loading: true }));
  useEffect(() => {
    let active = true;
    // A refresh keeps the confirmed data; a new chain or path starts empty.
    setState((previous) => previous.scope === scope ? { ...previous, error: "", loading: true } : { scope, data: null, error: "", loading: true });
    chainApi<T>(chainId, path)
      .then((data) => {
        if (active) setState({ scope, data, error: "", loading: false });
      })
      .catch((e) => {
        if (active) setState((previous) => ({ scope, data: previous.scope === scope ? previous.data : null, error: errorMessage(e), loading: false }));
      });
    return () => {
      active = false;
    };
  }, [path, version, chainId]);
  // Until the effect runs for a newly selected chain or path, never expose the previous scope's result.
  return state.scope === scope ? { data: state.data, error: state.error, loading: state.loading } : { data: null, error: "", loading: true };
}
