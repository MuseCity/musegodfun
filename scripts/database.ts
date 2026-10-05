import { readFile, writeFile } from "node:fs/promises";
import { SupabaseStore } from "../server/supabase-store";
import { loadEnvironment } from "../server/config";
loadEnvironment();
const [operation, file, scope = process.env.SUPABASE_DATA_SCOPE || process.env.CHAIN_MODE || "robinhood"] = process.argv.slice(3);
if (!file || !["backup", "restore"].includes(operation))
  throw new Error(
    "Usage: npm run db:backup -- file.json [scope] or npm run db:restore -- file.json restore-<name>",
  );
const store = new SupabaseStore(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SECRET_KEY || "",
  scope,
);
if (operation === "backup") {
  await writeFile(file, JSON.stringify(await store.backup(), null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log("Backup saved; credentials are not included.");
} else {
  if (!scope.startsWith("restore-"))
    throw new Error("Restore only writes to a new restore- scope; existing production scopes cannot be overwritten.");
  await store.restore(JSON.parse(await readFile(file, "utf8")));
  console.log("Backup restored into isolated scope:", scope);
}
