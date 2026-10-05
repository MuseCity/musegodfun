import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readBuildIdentity, writeBuildInfo } from "./scripts/build-info.ts";
const identity = readBuildIdentity();
export default defineConfig({
  define: { __BUILD_IDENTITY__: JSON.stringify(identity) },
  plugins: [react(), {
    name: "build-provenance",
    apply: "build",
    closeBundle() { writeBuildInfo(resolve("dist"), identity); },
  }],
  server: { host: "127.0.0.1" },
});
