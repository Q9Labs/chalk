import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cutoverStages } from "../registry.ts";
import { driftChildEnv } from "./drift.ts";
import { postToOncall } from "../oncall-alert.mjs";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "chalk-infra-drift-"));
const incidents = [];
try {
  // Sequential even if two entries share a state store; never use drift repair.
  for (const { stack, stage } of cutoverStages()) {
    const { env, missing } = driftChildEnv(stack, stage, process.env, directory);
    const log = openSync(join(directory, `${stack}-${stage}.log`), "wx", 0o600);
    let result;
    try {
      result = missing ? { status: 1 } : spawnSync("pnpm", ["exec", "tsx", "run-stack.ts", "drift", stack, stage], { cwd, env, stdio: ["ignore", log, log], timeout: 600_000 });
    } finally {
      closeSync(log);
    }
    if (missing) console.log(`${stack}/${stage}: missing the ${missing} secret`);
    const status = result.status === 0 ? "clean" : result.status === 2 ? "drift" : "check-failed";
    console.log(`${stack}/${stage}: ${status}`);
    if (status !== "clean") incidents.push({ id: `infra-drift-${stack}-${stage}`, title: `Infrastructure ${status}: ${stack}/${stage}`, severity: "high", url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  }
  if (incidents.length) {
    if (!process.env.ONCALL_WEBHOOK_URL) throw new Error("Oncall webhook is required when drift checking fails");
    await postToOncall({ fetchImpl: fetch, url: process.env.ONCALL_WEBHOOK_URL, incidents, drill: false });
    process.exitCode = 1;
  }
} finally {
  // Provider output can contain private state. Never print or upload raw logs.
  rmSync(directory, { recursive: true, force: true });
}
