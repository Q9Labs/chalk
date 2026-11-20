import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cutoverStages } from "../registry.ts";
import { postToOncall } from "../oncall-alert.mjs";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "chalk-infra-drift-"));
const incidents = [];
// These stacks evaluate their program from a private inputs JSON (no credentials), which the workflow passes as a secret.
const inputSecrets = { sfu: "CHALK_SFU_INPUTS", "sfu-standby": "CHALK_SFU_STANDBY_INPUTS", recorder: "CHALK_RECORDER_INPUTS" };
try {
  // Sequential even if two entries share a state store; never use drift repair.
  for (const { stack, stage } of cutoverStages()) {
    const secret = inputSecrets[stack];
    const inputs = secret ? process.env[secret] : undefined;
    const env = { ...process.env, CHALK_INFRA_INPUTS: undefined };
    for (const name of Object.values(inputSecrets)) delete env[name];
    if (secret && inputs) {
      env.CHALK_INFRA_INPUTS = join(directory, `${stack}-${stage}-inputs.json`);
      writeFileSync(env.CHALK_INFRA_INPUTS, inputs, { mode: 0o600 });
    }
    const log = openSync(join(directory, `${stack}-${stage}.log`), "wx", 0o600);
    let result;
    try {
      result = secret && !inputs ? { status: 1 } : spawnSync("pnpm", ["exec", "tsx", "run-stack.ts", "drift", stack, stage], { cwd, env, stdio: ["ignore", log, log], timeout: 600_000 });
    } finally {
      closeSync(log);
    }
    if (secret && !inputs) console.log(`${stack}/${stage}: missing the ${secret} secret`);
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
