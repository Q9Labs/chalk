import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";

export const PRODUCTION_PROJECT = "chalk";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function parseArguments(arguments_) {
  const { values } = parseArgs({
    args: arguments_[0] === "--" ? arguments_.slice(1) : arguments_,
    options: {
      sha: { type: "string" },
      target: { type: "string", default: "production" },
      "without-asset-retention": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!["production", "nightly"].includes(values.target)) throw new Error("--target must be production or nightly");
  return values;
}

function normalizeSHA(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Expected a full 40-character lowercase commit SHA");
  return sha;
}

// The workflow owns all shared-destination writes; local and CI callers only dispatch it.
export async function runWebRelease({ arguments_ = process.argv.slice(2), commandRunner = runCommand, rootDirectory = repositoryRoot } = {}) {
  const options = parseArguments(arguments_);
  const execute = (command, args) => commandRunner({ command, args, cwd: rootDirectory });
  const sha = normalizeSHA(options.sha ?? (await execute("git", ["rev-parse", "HEAD"])).trim());
  const requestId = randomUUID();
  const args = ["workflow", "run", "ci.yml", "--ref", "master", "-f", `target_sha=${sha}`, "-f", `managed_environment=${options.target}`, "-f", "release_managed=false", "-f", "deploy_managed=false", "-f", "deploy_web=true", "-f", `web_dispatch_id=${requestId}`];
  if (options["without-asset-retention"]) args.push("-f", "without_asset_retention=true");
  if (options["dry-run"]) {
    console.log(`gh ${args.join(" ")}\nThen wait for this exact workflow run with gh run watch --exit-status.`);
    return;
  }
  await execute("gh", args);
  await waitForRun(execute, `Release ${sha} ${requestId}`, requestId);
}

async function waitForRun(execute, title, requestId) {
  const deadline = Date.now() + 120_000;
  do {
    const runs = JSON.parse(await execute("gh", ["run", "list", "--workflow", "ci.yml", "--event", "workflow_dispatch", "--limit", "100", "--json", "databaseId,displayTitle"]));
    const run = runs.find((entry) => entry.displayTitle === title);
    if (run) {
      console.log(`Waiting for web release run ${run.databaseId}`);
      await execute("gh", ["run", "watch", String(run.databaseId), "--exit-status"]);
      return;
    }
    await setTimeout(2_000);
  } while (Date.now() < deadline);
  throw new Error(`Dispatched web release ${requestId}, but its run did not appear within two minutes. Find it in gh run list before retrying; do not dispatch a duplicate.`);
}

async function runCommand({ command, args, cwd }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runWebRelease().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
