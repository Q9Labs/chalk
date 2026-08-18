import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, parseJson } from "./managed-release-support.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const documentVersionPattern = /^[1-9][0-9]*$/;
const invocationCompletion = new Map([
  ["Success", true],
  ["Cancelled", true],
  ["Cancelling", true],
  ["Failed", true],
  ["TimedOut", true],
  ["Pending", false],
  ["InProgress", false],
  ["Delayed", false],
]);
const documentStatusHandlers = {
  Active: () => "active",
  Creating: () => "pending",
  Updating: () => "pending",
  Failed: (version) => failDocumentStatus(version, "Failed"),
  Deleting: (version) => failDocumentStatus(version, "Deleting"),
};

export async function ensureDocumentVersion({ commandRunner, document, documentName, region, sleep = sleepFor }) {
  if (!document) throw new Error("managed deployment document is required");
  const versions = await listDocumentVersions({ commandRunner, documentName, region });
  if (!versions) return createDocumentVersion({ commandRunner, document, documentName, region, sleep });
  const matching = versions.find((version) => version?.VersionName === document.versionName);
  if (matching) return reuseDocumentVersion({ commandRunner, documentName, matching, region, sleep });
  return updateDocumentVersion({ commandRunner, document, documentName, region, sleep });
}

export async function waitForInvocation({ commandId, commandRunner, instanceId, region, sleep, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const invocation = await loadInvocation({ commandId, commandRunner, instanceId, region });
    if (!invocation) {
      await sleep(5_000);
      continue;
    }
    if (invocationIsComplete(invocation)) return invocation;
    await sleep(5_000);
  }
  await cancelTimedOutInvocation({ commandId, commandRunner, instanceId, region, timeoutSeconds });
}

export function parseCommandId(output) {
  const response = parseJson(output, "SSM send-command returned invalid JSON");
  const commandId = response?.Command?.CommandId;
  if (typeof commandId !== "string" || !/^[0-9a-f-]{36}$/.test(commandId)) throw new Error("SSM send-command did not return a valid command ID");
  return commandId;
}

export function invocationError(invocation, commandId) {
  const detail = [invocation.StatusDetails, invocation.StandardOutputContent, invocation.StandardErrorContent]
    .filter((value) => typeof value === "string" && value.trim())
    .join(": ")
    .slice(0, 4_000);
  return new Error(`SSM deployment ${commandId} ended with ${invocation.Status}${detail ? `: ${detail}` : ""}`);
}

export function awsCommand(region, args) {
  return {
    command: "aws",
    args: ["--no-cli-pager", "--region", region, ...args],
    cwd: repositoryRoot,
  };
}

export async function runCommand(specification) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(specification.command, specification.args, {
      cwd: specification.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => rejectPromise(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(`${specification.command} ${specification.args[2] ?? "command"} failed with exit ${code}: ${stderr.trim()}`));
    });
  });
}

export function sleepFor(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function listDocumentVersions({ commandRunner, documentName, region }) {
  try {
    const result = await commandRunner(awsCommand(region, ["ssm", "list-document-versions", "--name", documentName, "--output", "json"]));
    return parseDocumentVersions(result.stdout);
  } catch (error) {
    if (errorMessage(error).includes("InvalidDocument")) return undefined;
    throw error;
  }
}

async function createDocumentVersion({ commandRunner, document, documentName, region, sleep }) {
  const created = await commandRunner(awsCommand(region, ["ssm", "create-document", "--name", documentName, "--document-type", "Command", "--document-format", document.format, "--version-name", document.versionName, "--content", `file://${document.path}`, "--output", "json"]));
  const version = parsePublishedDocumentVersion(created.stdout);
  await waitForDocumentActive({ commandRunner, documentName, documentVersion: version, region, sleep });
  return version;
}

async function updateDocumentVersion({ commandRunner, document, documentName, region, sleep }) {
  const updated = await commandRunner(awsCommand(region, ["ssm", "update-document", "--name", documentName, "--document-version", "$LATEST", "--document-format", document.format, "--version-name", document.versionName, "--content", `file://${document.path}`, "--output", "json"]));
  const version = parsePublishedDocumentVersion(updated.stdout);
  await waitForDocumentActive({ commandRunner, documentName, documentVersion: version, region, sleep });
  return version;
}

async function reuseDocumentVersion({ commandRunner, documentName, matching, region, sleep }) {
  const version = normalizeDocumentVersion(matching.DocumentVersion);
  const progress = documentProgress(matching.Status, version);
  if (progress === "active") return version;
  await waitForDocumentActive({ commandRunner, documentName, documentVersion: version, region, sleep });
  return version;
}

async function waitForDocumentActive({ commandRunner, documentName, documentVersion, region, sleep }) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const status = await describeDocumentStatus({ commandRunner, documentName, documentVersion, region });
    if (documentProgress(status, documentVersion) === "active") return;
    if (attempt < 30) await sleep(2_000);
  }
  throw new Error(`SSM document version ${documentVersion} did not become active`);
}

async function describeDocumentStatus({ commandRunner, documentName, documentVersion, region }) {
  try {
    const result = await commandRunner(awsCommand(region, ["ssm", "describe-document", "--name", documentName, "--document-version", documentVersion, "--output", "json"]));
    const response = parseJson(result.stdout, "SSM describe-document returned invalid JSON");
    return response?.Document?.Status;
  } catch (error) {
    if (isPendingDocumentError(error)) return "Creating";
    throw error;
  }
}

function isPendingDocumentError(error) {
  const message = errorMessage(error);
  return message.includes("InvalidDocument") || message.includes("does not exist");
}

function documentProgress(status, version) {
  const handler = documentStatusHandlers[status] ?? failUnsupportedDocumentStatus;
  return handler(version, status);
}

function failDocumentStatus(version, status) {
  throw new Error(`SSM document version ${version} entered ${status}`);
}

function failUnsupportedDocumentStatus(version, status) {
  throw new Error(`SSM document version ${version} returned unsupported status: ${statusLabel(status)}`);
}

async function loadInvocation({ commandId, commandRunner, instanceId, region }) {
  try {
    const result = await commandRunner(awsCommand(region, ["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId, "--plugin-name", "deployRelease", "--output", "json"]));
    return parseJson(result.stdout, "SSM get-command-invocation returned invalid JSON");
  } catch (error) {
    if (errorMessage(error).includes("InvocationDoesNotExist")) return undefined;
    throw error;
  }
}

function invocationIsComplete(invocation) {
  const completion = invocationCompletion.get(invocation.Status);
  if (completion !== undefined) return completion;
  throw new Error(`SSM returned an unsupported command status: ${statusLabel(invocation.Status)}`);
}

function statusLabel(status) {
  return typeof status === "string" ? status : "missing";
}

async function cancelTimedOutInvocation({ commandId, commandRunner, instanceId, region, timeoutSeconds }) {
  try {
    await commandRunner(awsCommand(region, ["ssm", "cancel-command", "--command-id", commandId, "--instance-ids", instanceId]));
  } catch (error) {
    throw new Error(`SSM deployment timed out after ${timeoutSeconds} seconds, and cancellation failed: ${errorMessage(error)}`);
  }
  throw new Error(`SSM deployment timed out after ${timeoutSeconds} seconds and was cancelled`);
}

function parseDocumentVersions(output) {
  const response = parseJson(output, "SSM list-document-versions returned invalid JSON");
  if (!Array.isArray(response?.DocumentVersions)) throw new Error("SSM list-document-versions did not return DocumentVersions");
  return response.DocumentVersions;
}

function parsePublishedDocumentVersion(output) {
  const response = parseJson(output, "SSM document publish returned invalid JSON");
  return normalizeDocumentVersion(response?.DocumentDescription?.DocumentVersion);
}

function normalizeDocumentVersion(version) {
  const value = String(version ?? "");
  if (!documentVersionPattern.test(value)) throw new Error("SSM did not return a pinned numeric document version");
  return value;
}
