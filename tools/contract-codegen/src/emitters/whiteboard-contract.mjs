// @ts-check

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** @typedef {Record<string, any>} WhiteboardContract */

export function whiteboardContractPath() {
  return resolve(process.env.CODEGEN_WHITEBOARD_CONTRACT_PATH ?? resolve(repositoryRoot, "contract/schema/whiteboard-v1.json"));
}

export async function loadWhiteboardContract(inputPath = whiteboardContractPath()) {
  const contract = /** @type {WhiteboardContract} */ (JSON.parse(await readFile(inputPath, "utf8")));
  validateWhiteboardContract(contract);
  return contract;
}

/** @param {WhiteboardContract} contract */
function validateWhiteboardContract(contract) {
  if (contract.$schema !== "chalk.whiteboard.v1" || contract.version !== 1) {
    throw new Error("Invalid whiteboard contract: expected chalk.whiteboard.v1 version 1");
  }
  if (contract.protocol?.name !== "whiteboard-v1" || contract.protocol?.route !== "/v1/whiteboard" || contract.protocol?.transport !== "websocket-json-text") {
    throw new Error("Invalid whiteboard contract: protocol must define whiteboard-v1 at /v1/whiteboard over JSON text WebSockets");
  }

  requireExactStrings(contract.capabilities, ["drawWhiteboard", "manageWhiteboard"], "capabilities");
  requireExactStrings(contract.clientFrames, ["hello", "submit_update", "request_snapshot", "snapshot_ack", "clear", "set_draw_permission", "cursor", "ping"], "clientFrames");
  requireExactStrings(contract.serverFrames, ["welcome", "snapshot_page", "update", "commit", "cursor", "permission_updated", "reset_required", "operation_error", "pong"], "serverFrames");
  requireExactStrings(contract.receiptOperations, ["submit_update", "clear", "set_draw_permission"], "receiptOperations");
  requireExactStrings(contract.receiptOutcomes, ["committed", "duplicate"], "receiptOutcomes");
  requireExactStrings(contract.resetReasons, ["scene_changed", "cursor_expired", "gap"], "resetReasons");

  for (const key of [
    "decodedInboundFrameBytes",
    "encodedOutboundFrameBytes",
    "tokenBytes",
    "operationIdMinBytes",
    "operationIdMaxBytes",
    "requestIdMinBytes",
    "requestIdMaxBytes",
    "elementIdMaxBytes",
    "elementTypeMaxBytes",
    "elementIndexMaxBytes",
    "elementPayloadEncodedBytes",
    "elementBatchMaxItems",
    "snapshotPageMaxItems",
    "snapshotPageEncodedBytes",
    "snapshotMaxPages",
    "cursorFrameBytes",
    "displayNameMaxBytes",
    "errorMessageMaxBytes",
    "jsonMaxDepth",
    "socketQueueMaxFrames",
    "socketQueueMaxBytes",
    "socketQueueMaxAgeMs",
    "cursorTtlMs",
    "cursorRatePerSecond",
    "pendingOperationMaxItems",
    "sceneElementMaxItems",
    "sceneJsonMaxBytes",
    "sceneObjectMaxBytes",
  ]) {
    if (!Number.isSafeInteger(contract.limits?.[key]) || contract.limits[key] <= 0) {
      throw new Error(`Invalid whiteboard contract: limits.${key} must be a positive safe integer`);
    }
  }

  if (contract.limits.operationIdMinBytes > contract.limits.operationIdMaxBytes || contract.limits.requestIdMinBytes > contract.limits.requestIdMaxBytes) {
    throw new Error("Invalid whiteboard contract: identifier minimums cannot exceed maximums");
  }
  if (contract.persistence?.fullSyncDeletesAbsentElements !== false || contract.persistence?.clearStartsNewSceneEpoch !== true || contract.persistence?.operationReceipts !== true) {
    throw new Error("Invalid whiteboard contract: merge, clear, and receipt persistence semantics are required");
  }
  if (contract.fileTransport?.initiateUploadResult?.method !== "PUT" || contract.fileTransport?.initiateUploadResult?.headers !== "exact-string-map") {
    throw new Error("Invalid whiteboard contract: upload initiation must preserve the exact signed PUT headers");
  }

  const frameEntries = Object.values(contract.frames ?? {});
  if (frameEntries.length !== 14 || frameEntries.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new Error("Invalid whiteboard contract: all strict frame definitions are required");
  }
}

/** @param {unknown} actual @param {string[]} expected @param {string} field */
function requireExactStrings(actual, expected, field) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Invalid whiteboard contract: ${field} must match the frozen ordered set`);
  }
}
