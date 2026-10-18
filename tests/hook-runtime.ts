import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

type Cleanup = (() => void) | void;
type Slot = { deps?: readonly unknown[]; cleanup?: Cleanup };

/** A tiny stateful React hooks runtime without a DOM: state changes re-render, and an effect runs again when its deps change. */
export function hookRuntime<T>(component: () => T) {
  const values: unknown[] = [], refs: { current: unknown }[] = [], slots: Slot[] = [];
  let cursor = { state: 0, ref: 0, effect: 0 }, queued: { index: number; run: () => Cleanup; deps?: readonly unknown[] }[] = [];
  let dirty = false, rendering = false, scheduled = false, closed = false, latest: T;
  const unchanged = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  function render() {
    for (let pass = 0; ; pass++) {
      if (pass > 50) throw new Error("Render loop");
      cursor = { state: 0, ref: 0, effect: 0 }; queued = []; dirty = false; rendering = true;
      try { latest = component(); } finally { rendering = false; }
      const due = queued.filter(effect => !unchanged(slots[effect.index]?.deps, effect.deps));
      for (const effect of due) slots[effect.index]?.cleanup?.();
      for (const effect of due) slots[effect.index] = { deps: effect.deps, cleanup: effect.run() };
      if (!dirty) return latest;
    }
  }
  function schedule() {
    dirty = true;
    if (rendering || scheduled || closed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (dirty && !closed) render(); });
  }
  const hooks = {
    useState<S>(initial: S | (() => S)) {
      const index = cursor.state++;
      if (!(index in values)) values[index] = typeof initial === "function" ? (initial as () => S)() : initial;
      return [values[index] as S, (next: S | ((current: S) => S)) => {
        const value = typeof next === "function" ? (next as (current: S) => S)(values[index] as S) : next;
        if (!Object.is(value, values[index])) { values[index] = value; schedule(); }
      }] as const;
    },
    useRef<R>(initial: R) { return (refs[cursor.ref++] ??= { current: initial }) as { current: R }; },
    useCallback<F>(run: F, deps?: readonly unknown[]) {
      const slot = hooks.useRef<{ run: F; deps?: readonly unknown[] } | null>(null);
      if (!slot.current || !unchanged(slot.current.deps, deps)) slot.current = { run, deps };
      return slot.current.run;
    },
    useEffect(run: () => Cleanup, deps?: readonly unknown[]) { queued.push({ index: cursor.effect++, run, deps }); },
  };
  return { hooks, render, output: () => latest, unmount() { closed = true; for (const slot of slots) slot?.cleanup?.(); } };
}

/** Lets every pending promise continuation, and the re-render it triggers, finish. */
export const settle = () => new Promise<void>(resolve => setImmediate(resolve));

/** Imports a source file fresh, replacing some bindings of the modules it imports directly (keyed by specifier); the rest stays real.
 * `expose` adds exports for names the file keeps private. */
export async function importFresh(path: string, replace: Record<string, { file: string; bindings: Record<string, unknown> }>, expose: string[] = []) {
  const entry = pathToFileURL(`${process.cwd()}/${path}`); entry.search = `fresh=${crypto.randomUUID()}`;
  const key = `__fresh${crypto.randomUUID().replaceAll("-", "")}`;
  Reflect.set(globalThis, key, replace);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const target = replace[specifier];
      if (context.parentURL !== entry.href || !target) return next(specifier, context);
      const names = Object.keys(target.bindings).join(",");
      const source = `export * from ${JSON.stringify(target.file)};export const {${names}}=globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}].bindings;`;
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    },
    load(url, context, next) {
      const result = next(url, context);
      return expose.length && url === entry.href ? { ...result, source: `${result.source}\nexport { ${expose.join(", ")} };` } : result;
    },
  });
  try { return await import(entry.href) as Record<string, any>; }
  finally { hooks.deregister(); Reflect.deleteProperty(globalThis, key); }
}
