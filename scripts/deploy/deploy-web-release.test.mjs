import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildReleasePlan, parseArguments, parseDeploymentURL, runWebRelease } from "./deploy-web-release.mjs";

const fullSHA = "040a7c52698f8cf9b87b0ef48f918b681de9bc35";
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("parses the explicit release controls and enforces a full SHA in CI", () => {
  assert.deepEqual(parseArguments(["--", "--dry-run"]), {
    sha: undefined,
    skipStaging: false,
    dryRun: true,
  });
  assert.deepEqual(parseArguments(["--sha", fullSHA, "--skip-staging"]), {
    sha: fullSHA,
    skipStaging: true,
    dryRun: false,
  });
  assert.deepEqual(parseArguments(["--sha=" + fullSHA, "--dry-run"], { isCI: true }), {
    sha: fullSHA,
    skipStaging: false,
    dryRun: true,
  });
  assert.throws(() => parseArguments([], { isCI: true }), /required in CI/);
  assert.throws(() => parseArguments(["--sha", fullSHA.slice(0, 7)]), /full 40-character/);
});

test("defaults to the exact local HEAD SHA when no CI SHA is supplied", async () => {
  const calls = [];
  const result = await runWebRelease({
    arguments_: ["--dry-run"],
    environment: {},
    commandRunner: async (command) => {
      calls.push(command);
      if (command.command === "git" && command.args[0] === "rev-parse") return { stdout: fullSHA };
      if (command.command === "git" && command.args[0] === "status") return { stdout: "" };
      return { stdout: "", stderr: "" };
    },
    rootDirectory: "/repo",
    webPath: "/repo/apps/web",
  });

  assert.equal(result.sha, fullSHA);
  assert.equal(calls.filter(({ command }) => command === "git").length, 2);
});

test("extracts only the staging Pages URL and keeps the production plan on one artifact", () => {
  assert.equal(parseDeploymentURL("Take a peek over at https://abc123.chalk-staging.pages.dev"), "https://abc123.chalk-staging.pages.dev");
  assert.throws(() => parseDeploymentURL("https://abc123.chalk.pages.dev"), /chalk-staging/);

  const plan = buildReleasePlan({ sha: fullSHA });
  assert.equal(plan.filter(({ args }) => args.includes("run") && args.includes("build")).length, 1);
  assert.equal(plan.filter(({ args }) => args.includes("pages") && args.includes("deploy")).length, 2);
  assert.equal(plan.filter(({ args }) => args.some((argument) => argument.endsWith("verify-web-deploy.mjs"))).length, 2);
  assert.equal(buildReleasePlan({ sha: fullSHA, skipStaging: true }).filter(({ args }) => args.includes("pages") && args.includes("deploy")).length, 1);
});

test("runs one build, both uploads, and both verifiers through structured commands", async () => {
  const calls = [];
  const commandRunner = async (command) => {
    calls.push(command);
    if (command.command === "git" && command.args[0] === "rev-parse") return { stdout: fullSHA };
    if (command.command === "git" && command.args[0] === "status") return { stdout: "" };
    if (command.command === "node" && command.args[0] === "--version") return { stdout: "v22.14.0" };
    if (command.command === "pnpm" && command.args[0] === "--version") return { stdout: "10.26.2" };
    if (command.command === "pnpm" && command.args.at(-1) === "--version") return { stdout: "4.107.0" };
    if (command.args.includes("--project-name") && command.args.includes("chalk-staging")) {
      return { stdout: "Take a peek over at https://abc123.chalk-staging.pages.dev", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  await runWebRelease({
    arguments_: ["--sha", fullSHA],
    environment: { CLOUDFLARE_API_TOKEN: "injected-by-test" },
    commandRunner,
    rootDirectory: "/repo",
    webPath: "/repo/apps/web",
    productionURL: "https://chalkmeet.com",
  });

  const installs = calls.filter(({ command, args }) => command === "pnpm" && args[0] === "install");
  const builds = calls.filter(({ command, args }) => command === "pnpm" && args.includes("run") && args.includes("build"));
  const uploads = calls.filter(({ args }) => args.includes("pages") && args.includes("deploy"));
  const verifications = calls.filter(({ args }) => args.some((argument) => argument.endsWith("verify-web-deploy.mjs")));
  assert.equal(installs.length, 1);
  assert.equal(builds.length, 1);
  assert.equal(builds[0].env.CHALK_COMMIT_SHA, fullSHA);
  assert.equal(builds[0].env.CHALK_ENVIRONMENT, "production");
  assert.equal(uploads.length, 2);
  assert.equal(verifications.length, 2);
  assert.ok(uploads.every(({ cwd }) => cwd === "/repo/apps/web"));
  assert.equal(verifications[0].args.at(-1), fullSHA);
  assert.equal(verifications[1].args.at(-1), "--production");
});
