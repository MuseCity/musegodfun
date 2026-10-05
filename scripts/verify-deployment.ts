import { verifyDeployment } from "./deployment-verification";

const args = process.argv.slice(2);
const usage = "Usage: npm run verify:deployment -- --release build-<runID>-<attempt> --origin https://musegod.fun";

try {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--release", "--origin"].includes(key) || !value || value.startsWith("--") || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }
  const release = values.get("--release"), origin = values.get("--origin");
  if (!release || !origin) throw new Error(usage);
  const summary = await verifyDeployment({ release, origin, githubToken: process.env.GITHUB_TOKEN });
  console.log(JSON.stringify({ verified: true, ...summary }, null, 2));
} catch (error) {
  console.error(`Deployment verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
