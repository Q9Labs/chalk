import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevConfig } from "./config.mjs";
import { readManifest, readOwner, validateOwnedPid } from "./ownership.mjs";
import { runCommand } from "../lib/platform.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const config = resolveDevConfig({ root });
const owner = await readOwner(config);
const manifest = await readManifest(config);
if (!owner || owner.checkout !== config.root || manifest?.state !== "ready" || !(await validateOwnedPid(owner.supervisorPid, { expectedCommand: owner.supervisorExpectedCommand }))) throw new Error("Start this checkout with pnpm dev and wait for Chalk dev ready before running dev:smoke");
const runId = `dev-smoke-${Date.now()}`;
process.exitCode = runCommand(process.execPath, [".agents/skills/verify-chalk/scripts/join-call.mjs", runId], { cwd: root });
console.log(`Evidence: ${join(root, ".verify", runId)}`);
