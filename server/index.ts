import express from "express";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp, knownPage } from "./app";
import { loadEnvironment, redact } from "./config";

loadEnvironment();
const vite = process.env.NODE_ENV === "production" ? null : await (await import("vite")).createServer({
  server: { middlewareMode: true }, appType: "custom",
});
const { app, service } = createApp((app) => {
  if (!vite) {
    app.use(express.static(resolve("dist")));
    app.get("/{*path}", (req, res) => {
      res.status(knownPage(req.path) ? 200 : 404).sendFile(resolve("dist/index.html"));
    });
  } else {
    app.use(vite.middlewares);
    app.get("/{*path}", (req, res, next) => {
      void (async () => {
        const html = await vite.transformIndexHtml(req.originalUrl, await readFile(resolve("index.html"), "utf8"));
        res.status(knownPage(req.path) ? 200 : 404).type("html").send(html);
      })().catch(next);
    });
  }
});

const port = Number(process.env.PORT || 5188);
const server = app.listen(port, "127.0.0.1", () =>
  console.log(
    `musegod.fun: http://127.0.0.1:${port} · ${service.runtime.config.mode} · signing ${service.runtime.config.writesEnabled ? "enabled" : "disabled"}`,
  ),
);

server.headersTimeout = 15000;
server.requestTimeout = 30000;
const upkeep = setInterval(() => {
  void Promise.resolve(service.store.cleanup()).catch(() => {});
  void service.reconcile().catch(() => {});
}, 30000);
upkeep.unref();
// Keep health/read-only diagnostics available through a transient database
// outage. Every operation still requires its persistent store to succeed.
void Promise.resolve(service.store.health())
  .then(() => service.store.cleanup())
  .then(() => service.reconcile())
  .catch((error) => console.error(`Database startup check failed: ${redact(error)}`));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    clearInterval(upkeep);
    server.close(() => {
      void Promise.resolve(service.store.close()).finally(() =>
        process.exit(0),
      );
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
process.on("unhandledRejection", (e) => console.error(redact(e)));
