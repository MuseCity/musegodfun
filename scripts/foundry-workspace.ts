import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Foundry can fall back to the Git root and load its .env, even when cwd itself is empty. */
export async function createFoundryWorkspace() {
  const cwd = await mkdtemp(join(await realpath(tmpdir()), "musegod-foundry-"));
  const remove = () => rm(cwd, { recursive: true, force: true });
  try {
    for (let ancestor = cwd; ; ancestor = dirname(ancestor)) {
      assert(!existsSync(join(ancestor, ".git")), "Foundry's temporary cwd must have no Git ancestor");
      if (dirname(ancestor) === ancestor) break;
    }
    assert(!existsSync(join(cwd, ".env")) && !existsSync(join(cwd, "foundry.toml")),
      "Foundry's temporary cwd must contain neither .env nor foundry.toml");
    return { cwd, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
