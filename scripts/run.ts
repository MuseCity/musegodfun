import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadEnvironment, redact } from "../server/config";
loadEnvironment();
try {
  await import(pathToFileURL(resolve(process.argv[2])).href);
} catch (e) {
  console.error(redact(e));
  process.exitCode = 1;
}
