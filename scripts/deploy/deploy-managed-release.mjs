#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_SECONDS, normalizeExclusions, parseArguments, usage } from "./managed-release-arguments.mjs";
import { buildDeploymentRequest, buildDocumentParameters, buildDryRunProof, CONTROLLER_VERSION, loadAllowedSecretIds, loadDocument, loadManifest, parseControllerResult, runtimeInputsPath } from "./managed-release-contracts.mjs";
import { awsCommand, ensureDocumentVersion, invocationError, parseCommandId, runCommand, sleepFor, waitForInvocation } from "./managed-release-ssm.mjs";
import { errorMessage } from "./managed-release-support.mjs";

export { DEFAULT_TIMEOUT_SECONDS, normalizeExclusions, parseArguments, usage } from "./managed-release-arguments.mjs";
export { buildDeploymentRequest, buildDocumentParameters, CONTROLLER_VERSION, parseControllerResult } from "./managed-release-contracts.mjs";
export { ensureDocumentVersion } from "./managed-release-ssm.mjs";

export async function runManagedRelease({ arguments_, commandRunner = runCommand, now = () => new Date(), sleep = sleepFor, allowedSecretIds, stdout = process.stdout } = {}) {
  const options = parseArguments(arguments_ ?? []);
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return { help: true };
  }

  const release = await prepareRelease({ allowedSecretIds, now, options });
  if (options.dryRun) {
    const proof = buildDryRunProof({ ...release, options });
    stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
    return proof;
  }

  const result = await deployRelease({ commandRunner, options, release, sleep });
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

async function prepareRelease({ allowedSecretIds, now, options }) {
  const manifest = await loadManifest(options.manifestPath);
  const secretIds = await resolveAllowedSecretIds(allowedSecretIds);
  const exclusions = normalizeExclusions(options.excludedSecrets, secretIds);
  const requestedAt = now().toISOString();
  const request = buildDeploymentRequest({ manifest, options, exclusions, requestedAt });
  const manifestBytes = await readFile(resolve(options.manifestPath));
  const manifestBase64 = encodeManifest(manifestBytes);
  const document = await loadRequestedDocument(options.documentPath);
  const parameters = buildDocumentParameters({ manifest, request, manifestBase64 });
  return { document, manifest, manifestBytes, parameters, request };
}

async function deployRelease({ commandRunner, options, release, sleep }) {
  const documentVersion = await resolveDocumentVersion({ commandRunner, document: release.document, options, sleep });
  const sendResult = await sendReleaseCommand({ commandRunner, documentVersion, options, release });
  const commandId = parseCommandId(sendResult.stdout);
  const invocation = await waitForInvocation({
    commandId,
    commandRunner,
    instanceId: options.instanceId,
    region: options.region,
    sleep,
    timeoutSeconds: options.timeoutSeconds,
  });
  if (invocation.Status !== "Success") throw invocationError(invocation, commandId);
  return parseControllerResult(invocation.StandardOutputContent, release.manifest.release_id, options.requestId);
}

async function resolveDocumentVersion({ commandRunner, document, options, sleep }) {
  if (options.documentVersion) return options.documentVersion;
  return ensureDocumentVersion({
    commandRunner,
    document,
    documentName: options.documentName,
    region: options.region,
    sleep,
  });
}

function sendReleaseCommand({ commandRunner, documentVersion, options, release }) {
  return commandRunner(
    awsCommand(options.region, [
      "ssm",
      "send-command",
      "--document-name",
      options.documentName,
      "--document-version",
      documentVersion,
      "--instance-ids",
      options.instanceId,
      "--comment",
      `Chalk ${release.manifest.release_id} (${options.requestId})`,
      "--parameters",
      JSON.stringify(release.parameters),
      "--timeout-seconds",
      String(options.timeoutSeconds),
      "--cloud-watch-output-config",
      JSON.stringify({
        CloudWatchLogGroupName: options.logGroupName,
        CloudWatchOutputEnabled: true,
      }),
      "--output",
      "json",
    ]),
  );
}

function resolveAllowedSecretIds(allowedSecretIds) {
  return allowedSecretIds ?? loadAllowedSecretIds(runtimeInputsPath);
}

function loadRequestedDocument(documentPath) {
  if (!documentPath) return undefined;
  return loadDocument(documentPath);
}

function encodeManifest(manifestBytes) {
  const manifestBase64 = manifestBytes.toString("base64");
  if (manifestBase64.length > 48_000) throw new Error("release manifest is too large for the constrained SSM document parameter");
  return manifestBase64;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runManagedRelease({ arguments_: process.argv.slice(2) }).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
