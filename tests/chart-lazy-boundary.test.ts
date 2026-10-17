import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { buildSync } from "esbuild";

test("the main entry's static chunk graph excludes the price chart and its library", () => {
  const { metafile } = buildSync({ entryPoints: ["src/main.tsx"], bundle: true, splitting: true, format: "esm", write: false,
    metafile: true, outdir: "chart-boundary-probe", external: ["/fonts/*", "*.css"], logLevel: "silent" });
  const outputs = metafile!.outputs, entry = Object.keys(outputs).find(path => outputs[path].entryPoint === "src/main.tsx");
  assert(entry, "the compiler must identify the real main entry");
  const reached = new Set<string>();
  function visit(path: string) {
    if (reached.has(path)) return;
    reached.add(path);
    assert(outputs[path], `missing compiled output ${path}`);
    for (const dependency of outputs[path].imports) if (dependency.kind === "import-statement" && !dependency.external) visit(dependency.path);
  }
  visit(entry);
  const inputs = [...reached].flatMap(path => Object.keys(outputs[path].inputs));
  assert(!inputs.some(path => resolve(path) === resolve("src/components/PriceChart.tsx")), "PriceChart must remain behind a dynamic import");
  assert(!inputs.some(path => path.includes("node_modules/lightweight-charts/")), "the chart library must not load on every route");
  assert(Object.values(outputs).some(output => Object.keys(output.inputs).some(path => path.includes("node_modules/lightweight-charts/"))),
    "the probe must include the real chart library in a lazy output");
});
