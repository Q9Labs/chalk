import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runManagedRelease } from "./deploy-managed-release.mjs";

const releaseId = "managed-episode-20260818T120000Z-01234567-89abcdef";
const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
const allowedSecretIds = ["api-env", "cloudflare-tunnel-token", "sync-env"];
const temporaryDirectories = [];

after(cleanTemporaryDirectories);

async function cleanTemporaryDirectories() {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { force: true, recursive: true })));
}

test("hands a release to the pinned SSM document and returns its controller proof", async () => {
  const manifestPath = await writeManifest();
  const calls = [];
  const commandId = "01234567-89ab-cdef-0123-456789abcdef";
  const controllerResult = {
    schema_version: 1,
    status: "deployed",
    release_id: releaseId,
    request_id: "12345.2",
    previous_release_id: "managed-episode-20260817T120000Z-89abcdef-01234567",
    health: "passed",
    rolled_back: false,
  };
  let invocation = 0;

  const result = await runManagedRelease({
    arguments_: requiredArguments(manifestPath).concat("--exclude-secret", "sync-env"),
    allowedSecretIds,
    commandRunner: async (command) => {
      calls.push(command);
      if (command.args.includes("send-command")) {
        return { stdout: JSON.stringify({ Command: { CommandId: commandId } }), stderr: "" };
      }
      invocation += 1;
      return {
        stdout: JSON.stringify(
          invocation === 1
            ? { Status: "InProgress" }
            : {
                Status: "Success",
                StandardOutputContent: `prepared\nRESULT ${JSON.stringify(controllerResult)}\n`,
              },
        ),
        stderr: "",
      };
    },
    sleep: async () => {},
    stdout: { write: () => {} },
  });

  const sendCommand = calls.find(({ args }) => args.includes("send-command"));
  assert.deepEqual(result, controllerResult);
  assert.equal(calls.filter(({ args }) => args.includes("send-command")).length, 1);
  assert.equal(calls.filter(({ args }) => args.includes("get-command-invocation")).length, 2);
  assert.equal(sendCommand.command, "aws");
  assert.equal(sendCommand.args[sendCommand.args.indexOf("--document-version") + 1], "7");
  const parameters = JSON.parse(sendCommand.args[sendCommand.args.indexOf("--parameters") + 1]);
  assert.deepEqual(parameters.ExcludedSecrets, ['["sync-env"]']);
  assert.deepEqual(parameters.ControllerVersion, ["2"]);
});

test("passes only the operator-controlled deployment flags through CI", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

  assert.match(workflow, /managed_secret_exclusions:/);
  assert.match(workflow, /--document infrastructure\/managed-episode\/ssm\/chalk-managed-episode-deploy\.json/);
  assert.match(workflow, /--adopt-existing-release/);
  assert.match(workflow, /args\+=\(--exclude-secret "\$secret_id"\)/);
  assert.match(workflow, /--parameter-prefix "\$CHALK_MANAGED_PARAMETER_PREFIX"/);
  assert.match(workflow, /group: deploy-managed-\$\{\{ inputs\.managed_environment \}\}/);
  assert.doesNotMatch(workflow, /AWS-RunShellScript/);
});

function requiredArguments(manifestPath = "/tmp/manifest.json") {
  return [
    "--manifest",
    manifestPath,
    "--environment",
    "staging",
    "--region",
    "ap-southeast-1",
    "--instance-id",
    "i-0123456789abcdef0",
    "--document-name",
    "Chalk-DeployManagedEpisode",
    "--document-version",
    "7",
    "--parameter-prefix",
    `/chalk/staging/episode/${releaseId}`,
    "--request-id",
    "12345.2",
    "--log-group-name",
    "/chalk/staging/deployments",
    "--adopt-existing-release",
  ];
}

async function writeManifest() {
  const directory = await mkdtemp(join(tmpdir(), "chalk-managed-release-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "release-manifest.json");
  await writeFile(
    path,
    `${JSON.stringify({
      schema_version: 2,
      release_id: releaseId,
      source_revision: sourceRevision,
      runtime_artifacts: { "scripts/chalk-runtime-health": "0".repeat(64) },
    })}\n`,
    { mode: 0o600 },
  );
  return path;
}
