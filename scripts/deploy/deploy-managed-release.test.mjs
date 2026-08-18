import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildDeploymentRequest, buildDocumentParameters, CONTROLLER_VERSION, ensureDocumentVersion, normalizeExclusions, parseArguments, parseControllerResult, runManagedRelease } from "./deploy-managed-release.mjs";
import { isApprovedRunCommand, loadAllowedSecretIds } from "./managed-release-contracts.mjs";

const releaseId = "managed-episode-20260818T120000Z-01234567-89abcdef";
const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
const allowedSecretIds = ["api-env", "cloudflare-tunnel-token", "sync-env"];
const trackedDocumentPath = fileURLToPath(new URL("../../infrastructure/managed-episode/ssm/chalk-managed-episode-deploy.json", import.meta.url));
const temporaryDirectories = [];

after(cleanTemporaryDirectories);

async function cleanTemporaryDirectories() {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { force: true, recursive: true })));
}

test("parses pinned SSM controls and repeated exact exclusions", () => {
  const options = parseArguments([
    "--manifest",
    "/tmp/manifest.json",
    "--environment=staging",
    "--region",
    "ap-southeast-1",
    "--instance-id",
    "i-0123456789abcdef0",
    "--document-name",
    "Chalk-DeployManagedEpisode",
    "--document-version",
    "7",
    "--parameter-prefix",
    "/chalk/staging/episode/release-id",
    "--request-id",
    "12345.2",
    "--log-group-name",
    "/chalk/staging/deployments",
    "--exclude-secret",
    "sync-env",
    "--exclude-secret=api-env",
    "--timeout-seconds",
    "1200",
  ]);

  assert.equal(options.documentVersion, "7");
  assert.deepEqual(options.excludedSecrets, ["sync-env", "api-env"]);
  assert.equal(options.timeoutSeconds, 1200);
  const unpinnedVersionArguments = requiredArguments();
  unpinnedVersionArguments[unpinnedVersionArguments.indexOf("7")] = "$LATEST";
  assert.throws(() => parseArguments(unpinnedVersionArguments), /pinned numeric/);
});

test("rejects unknown, duplicate, and wildcard secret exclusions", () => {
  assert.deepEqual(normalizeExclusions(["sync-env", "api-env"], allowedSecretIds), ["api-env", "sync-env"]);
  assert.throws(() => normalizeExclusions(["missing"], allowedSecretIds), /unknown/);
  assert.throws(() => normalizeExclusions(["api-env", "api-env"], allowedSecretIds), /duplicate/);
  assert.throws(() => normalizeExclusions(["*"], allowedSecretIds), /invalid/);
  assert.throws(() => normalizeExclusions([" api-env"], allowedSecretIds), /invalid/);
});

test("keeps the PlanetScale durability proof mandatory", async () => {
  const excludableIds = await loadAllowedSecretIds();
  assert.equal(excludableIds.includes("planetscale-sync-proof"), false);
  assert.throws(() => normalizeExclusions(["planetscale-sync-proof"], excludableIds), /unknown/);
});

test("builds the versioned deployment request and constrained document parameters", () => {
  const manifest = { release_id: releaseId, source_revision: sourceRevision };
  const options = parseArguments(requiredArguments());
  const request = buildDeploymentRequest({
    manifest,
    options,
    exclusions: ["sync-env"],
    requestedAt: "2026-08-18T12:30:00.000Z",
  });
  const parameters = buildDocumentParameters({ manifest, request, manifestBase64: "e30K" });

  assert.equal(request.controller_version, CONTROLLER_VERSION);
  assert.deepEqual(request.excluded_secrets, ["sync-env"]);
  assert.deepEqual(parameters.ControllerVersion, ["1"]);
  assert.deepEqual(parameters.ExcludedSecrets, ['["sync-env"]']);
});

test("dry-run prints a redacted request and never invokes AWS", async () => {
  const manifestPath = await writeManifest();
  const documentPath = trackedDocumentPath;
  const writes = [];
  const result = await runManagedRelease({
    arguments_: requiredArguments(manifestPath, documentPath).concat("--exclude-secret", "sync-env", "--dry-run"),
    allowedSecretIds,
    commandRunner: async () => assert.fail("AWS must not run during dry-run"),
    now: () => new Date("2026-08-18T12:30:00.000Z"),
    stdout: { write: (value) => writes.push(value) },
  });

  assert.equal(result.dry_run, true);
  assert.deepEqual(result.request.excluded_secrets, ["sync-env"]);
  assert.match(result.parameters.ManifestBase64[0], /^<base64:/);
  assert.match(result.target.document_version, /^<resolve:controller-v1-/);
  assert.equal(result.document.format, "JSON");
  assert.equal(writes.join("").includes("runtime_artifacts"), false);
});

test("rejects an untracked managed deployment document", async () => {
  const manifestPath = await writeManifest();
  const documentPath = await writeDocument();
  const document = JSON.parse(await readFile(documentPath, "utf8"));
  document.parameters.Command = { type: "String", interpolationType: "ENV_VAR" };
  await writeFile(documentPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });

  await assert.rejects(
    runManagedRelease({
      arguments_: requiredArguments(manifestPath, documentPath).concat("--dry-run"),
      allowedSecretIds,
      commandRunner: async () => assert.fail("AWS must not run for an unsafe document"),
      stdout: { write: () => {} },
    }),
    /must use the tracked controller v1 path/,
  );
});

test("rejects any additional root command in the managed deployment document", async () => {
  const document = JSON.parse(await readFile(trackedDocumentPath, "utf8"));
  const commands = document.mainSteps[0].inputs.runCommand;

  assert.equal(isApprovedRunCommand(commands), true);
  assert.ok(commands.includes('controller_relative="controller/chalk-deployment-controller"'));
  assert.equal(isApprovedRunCommand([...commands, "echo unexpected-root-command"]), false);
});

test("reuses or publishes the content-addressed SSM document version", async () => {
  const existingCalls = [];
  const existingVersion = await ensureDocumentVersion({
    commandRunner: async (command) => {
      existingCalls.push(command);
      return {
        stdout: JSON.stringify({
          DocumentVersions: [{ DocumentVersion: "4", VersionName: "controller-v1-0123456789abcdef", Status: "Active" }],
        }),
      };
    },
    document: {
      format: "JSON",
      path: "/repo/chalk-managed-episode-deploy.json",
      versionName: "controller-v1-0123456789abcdef",
    },
    documentName: "Chalk-DeployManagedEpisode",
    region: "ap-southeast-1",
  });
  assert.equal(existingVersion, "4");
  assert.equal(existingCalls.length, 1);

  const creatingCalls = [];
  const creatingVersion = await ensureDocumentVersion({
    commandRunner: async (command) => {
      creatingCalls.push(command);
      if (command.args.includes("list-document-versions")) {
        return {
          stdout: JSON.stringify({
            DocumentVersions: [{ DocumentVersion: "6", VersionName: "controller-v1-0123456789abcdef", Status: "Creating" }],
          }),
        };
      }
      return { stdout: JSON.stringify({ Document: { Status: "Active" } }) };
    },
    document: {
      format: "JSON",
      path: "/repo/chalk-managed-episode-deploy.json",
      versionName: "controller-v1-0123456789abcdef",
    },
    documentName: "Chalk-DeployManagedEpisode",
    region: "ap-southeast-1",
    sleep: async () => {},
  });
  assert.equal(creatingVersion, "6");
  assert.ok(creatingCalls[1].args.includes("describe-document"));

  const updateCalls = [];
  const updatedVersion = await ensureDocumentVersion({
    commandRunner: async (command) => {
      updateCalls.push(command);
      if (command.args.includes("list-document-versions")) {
        return { stdout: JSON.stringify({ DocumentVersions: [] }) };
      }
      if (command.args.includes("update-document")) {
        return { stdout: JSON.stringify({ DocumentDescription: { DocumentVersion: "5" } }) };
      }
      return { stdout: JSON.stringify({ Document: { Status: "Active" } }) };
    },
    document: {
      format: "JSON",
      path: "/repo/chalk-managed-episode-deploy.json",
      versionName: "controller-v1-fedcba9876543210",
    },
    documentName: "Chalk-DeployManagedEpisode",
    region: "ap-southeast-1",
    sleep: async () => {},
  });
  assert.equal(updatedVersion, "5");
  assert.ok(updateCalls[1].args.includes("$LATEST"));
  assert.ok(updateCalls[1].args.includes("file:///repo/chalk-managed-episode-deploy.json"));
  assert.ok(updateCalls[1].args.includes("JSON"));
  assert.ok(updateCalls[2].args.includes("describe-document"));

  const createCalls = [];
  const createdVersion = await ensureDocumentVersion({
    commandRunner: async (command) => {
      createCalls.push(command);
      if (command.args.includes("list-document-versions")) throw new Error("InvalidDocument: document does not exist");
      if (command.args.includes("create-document")) {
        return { stdout: JSON.stringify({ DocumentDescription: { DocumentVersion: "1" } }) };
      }
      return { stdout: JSON.stringify({ Document: { Status: "Active" } }) };
    },
    document: {
      format: "JSON",
      path: "/repo/chalk-managed-episode-deploy.json",
      versionName: "controller-v1-abcdef0123456789",
    },
    documentName: "Chalk-DeployManagedEpisode",
    region: "ap-southeast-1",
    sleep: async () => {},
  });
  assert.equal(createdVersion, "1");
  assert.ok(createCalls[1].args.includes("create-document"));
  assert.ok(createCalls[1].args.includes("JSON"));
  assert.ok(createCalls[2].args.includes("describe-document"));
});

test("sends one command, waits for health proof, and returns the controller result", async () => {
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
    arguments_: requiredArguments(manifestPath),
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

  assert.deepEqual(result, controllerResult);
  assert.equal(calls.filter(({ args }) => args.includes("send-command")).length, 1);
  assert.equal(calls.filter(({ args }) => args.includes("get-command-invocation")).length, 2);
  assert.ok(calls.every(({ command }) => command === "aws"));
});

test("requires an exact healthy controller result", () => {
  assert.throws(() => parseControllerResult("no result", releaseId, "12345.2"), /did not emit/);
  assert.throws(() => parseControllerResult(`RESULT ${JSON.stringify({ schema_version: 1, status: "deployed", release_id: releaseId, request_id: "wrong", health: "passed", rolled_back: false })}`, releaseId, "12345.2"), /does not prove/);
  assert.throws(
    () =>
      parseControllerResult(
        `RESULT ${JSON.stringify({
          schema_version: 1,
          status: "rolled_back",
          release_id: releaseId,
          request_id: "12345.2",
          health: "failed",
          rolled_back: true,
        })}`,
        releaseId,
        "12345.2",
      ),
    /does not prove/,
  );
});

test("workflow passes only explicit exclusions to a pinned SSM document", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /managed_secret_exclusions:/);
  assert.match(workflow, /--document infrastructure\/managed-episode\/ssm\/chalk-managed-episode-deploy\.json/);
  assert.doesNotMatch(workflow, /CHALK_MANAGED_SSM_DOCUMENT_VERSION/);
  assert.match(workflow, /args\+=\(--exclude-secret "\$secret_id"\)/);
  assert.match(workflow, /--parameter-prefix "\$CHALK_MANAGED_PARAMETER_PREFIX"/);
  assert.doesNotMatch(workflow, /CHALK_MANAGED_PARAMETER_PREFIX%\/.*RELEASE_ID/);
  assert.match(workflow, /group: deploy-managed-\$\{\{ inputs\.managed_environment \}\}/);
  assert.doesNotMatch(workflow, /AWS-RunShellScript/);
});

function requiredArguments(manifestPath = "/tmp/manifest.json", documentPath) {
  const arguments_ = [
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
    "--parameter-prefix",
    `/chalk/staging/episode/${releaseId}`,
    "--request-id",
    "12345.2",
    "--log-group-name",
    "/chalk/staging/deployments",
  ];
  arguments_.splice(12, 0, ...(documentPath ? ["--document", documentPath] : ["--document-version", "7"]));
  return arguments_;
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

async function writeDocument() {
  const directory = await mkdtemp(join(tmpdir(), "chalk-managed-document-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "chalk-managed-episode-deploy.json");
  const trackedDocument = await readFile(new URL("../../infrastructure/managed-episode/ssm/chalk-managed-episode-deploy.json", import.meta.url));
  await writeFile(path, trackedDocument, { mode: 0o600 });
  return path;
}
