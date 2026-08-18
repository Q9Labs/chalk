import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "./managed-release-support.mjs";

export const CONTROLLER_VERSION = 1;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
export const runtimeInputsPath = join(repositoryRoot, "infrastructure/managed-episode/contracts/runtime-inputs.json");
const managedDocumentPath = join(repositoryRoot, "infrastructure/managed-episode/ssm/chalk-managed-episode-deploy.json");

const releasePattern = /^managed-episode-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8,12}-[0-9a-f]{8}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const secretIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const expectedDocumentParameters = ["AwsRegion", "ControllerVersion", "Environment", "ExcludedSecrets", "ManifestBase64", "ParameterPrefix", "ReleaseId", "RequestId", "RequestedAt", "SourceRevision"];
const approvedRunCommandSha256 = "cd4dbe0db93a4e6e2ac66caee815993f5daa81958b116e80820443e4e18cbabc";

export async function loadAllowedSecretIds(path = runtimeInputsPath) {
  const contract = parseJson(await readFile(path, "utf8"), `runtime input contract is invalid: ${path}`);
  assertRuntimeInputContract(contract, path);
  const ids = contract.inputs.map((input) => input?.id);
  assertCanonicalSecretIds(ids, path);
  return contract.inputs.filter((input) => input.kind !== "proof").map((input) => input.id);
}

export async function loadManifest(path) {
  const resolvedPath = resolve(path);
  await assertRegularFile(resolvedPath, "release manifest");
  const manifest = parseJson(await readFile(resolvedPath, "utf8"), "release manifest is not valid JSON");
  assertManifest(manifest);
  return manifest;
}

export async function loadDocument(path) {
  const resolvedPath = resolve(path);
  assertTrackedDocumentPath(resolvedPath);
  await assertRegularFile(resolvedPath, "managed deployment document");
  const bytes = await readFile(resolvedPath);
  assertDocumentFile(bytes, resolvedPath);
  const document = parseJson(bytes.toString("utf8"), "managed deployment document is invalid JSON");
  assertDocumentContract(document);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    format: "JSON",
    path: resolvedPath,
    sha256: hash,
    versionName: `controller-v${CONTROLLER_VERSION}-${hash.slice(0, 16)}`,
  };
}

export function buildDeploymentRequest({ manifest, options, exclusions, requestedAt }) {
  return {
    schema_version: 1,
    controller_version: CONTROLLER_VERSION,
    release_id: manifest.release_id,
    source_revision: manifest.source_revision,
    environment: options.environment,
    aws_region: options.region,
    parameter_prefix: options.parameterPrefix,
    excluded_secrets: exclusions,
    request_id: options.requestId,
    requested_at: requestedAt,
  };
}

export function buildDocumentParameters({ manifest, request, manifestBase64 }) {
  return {
    ControllerVersion: [String(CONTROLLER_VERSION)],
    SourceRevision: [manifest.source_revision],
    ReleaseId: [manifest.release_id],
    Environment: [request.environment],
    AwsRegion: [request.aws_region],
    ParameterPrefix: [request.parameter_prefix],
    ExcludedSecrets: [JSON.stringify(request.excluded_secrets)],
    ManifestBase64: [manifestBase64],
    RequestId: [request.request_id],
    RequestedAt: [request.requested_at],
  };
}

export function parseControllerResult(output, expectedReleaseId, expectedRequestId) {
  const resultLine = String(output ?? "")
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("RESULT "));
  if (!resultLine) throw new Error("host controller did not emit a deployment result");
  const result = parseJson(resultLine.slice("RESULT ".length), "host controller emitted invalid result JSON");
  assertControllerResult(result, expectedReleaseId, expectedRequestId);
  return result;
}

export function isApprovedRunCommand(commands) {
  if (!Array.isArray(commands)) return false;
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex") === approvedRunCommandSha256;
}

export function buildDryRunProof({ document, manifest, manifestBytes, options, request, parameters }) {
  return {
    schema_version: 1,
    dry_run: true,
    release_id: manifest.release_id,
    source_revision: manifest.source_revision,
    target: {
      environment: options.environment,
      region: options.region,
      instance_id: options.instanceId,
      document_name: options.documentName,
      document_version: options.documentVersion ?? `<resolve:${document.versionName}>`,
    },
    request,
    manifest: {
      path: resolve(options.manifestPath),
      sha256: createHash("sha256").update(manifestBytes).digest("hex"),
      bytes: manifestBytes.length,
    },
    document,
    parameters: {
      ...parameters,
      ManifestBase64: [`<base64:${manifestBytes.length}-bytes>`],
    },
  };
}

async function assertRegularFile(path, label) {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
}

function assertManifest(manifest) {
  const rules = [
    [(value) => value?.schema_version === 2, "release manifest schema_version must be 2"],
    [(value) => releasePattern.test(value?.release_id ?? ""), "release manifest release_id is invalid"],
    [(value) => shaPattern.test(value?.source_revision ?? ""), "release manifest source_revision is invalid"],
    [(value) => isPlainObject(value?.runtime_artifacts), "release manifest runtime_artifacts are missing"],
  ];
  const failure = rules.find(([isValid]) => !isValid(manifest));
  if (failure) throw new Error(failure[1]);
}

function assertTrackedDocumentPath(path) {
  if (path !== managedDocumentPath) throw new Error(`managed deployment document must use the tracked controller v${CONTROLLER_VERSION} path`);
}

function assertDocumentFile(bytes, path) {
  if (bytes.length === 0 || bytes.length > 64_000) throw new Error("managed deployment document must contain between 1 and 64000 bytes");
  if (extname(path).toLowerCase() !== ".json") throw new Error("managed deployment document must be JSON");
}

function assertDocumentContract(document) {
  const record = Object(document);
  const steps = Array.isArray(record.mainSteps) ? record.mainSteps : [];
  const parameters = record.parameters;
  const step = Object(steps[0]);
  const commands = Object(step.inputs).runCommand;
  const rules = [
    () => record.schemaVersion === "2.2",
    () => steps.length === 1,
    () => isPlainObject(parameters),
    () => Object.keys(parameters).sort().join("\n") === expectedDocumentParameters.join("\n"),
    () => Object.values(parameters).every((parameter) => parameter?.interpolationType === "ENV_VAR"),
    () => step?.name === "deployRelease",
    () => step?.action === "aws:runShellScript",
    () => isApprovedRunCommand(commands),
  ];
  if (rules.some((isValid) => !isValid())) throw new Error("controller v1 requires the exact constrained deployRelease contract");
}

function assertRuntimeInputContract(contract, path) {
  const record = Object(contract);
  if (record.schema_version !== 1 || !Array.isArray(record.inputs)) throw new Error(`runtime input contract is invalid: ${path}`);
}

function assertCanonicalSecretIds(ids, path) {
  const invalidIndex = ids.findIndex((id) => typeof id !== "string" || !secretIdPattern.test(id));
  if (invalidIndex !== -1) throw new Error(`runtime input contract contains an invalid canonical ID: ${path}`);
  if (new Set(ids).size !== ids.length) throw new Error(`runtime input contract contains duplicate canonical IDs: ${path}`);
}

function assertControllerResult(result, expectedReleaseId, expectedRequestId) {
  const expected = {
    health: "passed",
    release_id: expectedReleaseId,
    request_id: expectedRequestId,
    rolled_back: false,
    schema_version: 1,
    status: "deployed",
  };
  const mismatch = Object.entries(expected).find(([key, value]) => result?.[key] !== value);
  if (mismatch) throw new Error("host controller result does not prove a healthy deployment");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
