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
  if (contract.extensions?.presentation?.name !== "presentation_v1") {
    throw new Error("Invalid whiteboard contract: presentation_v1 extension is required");
  }
  requireExactStrings(contract.extensions.presentation.exactFields, ["name"], "extensions.presentation.exactFields");
  if (contract.extensions?.view?.name !== "view_v1") {
    throw new Error("Invalid whiteboard contract: view_v1 extension is required");
  }
  requireExactStrings(contract.extensions.view.exactFields, ["name"], "extensions.view.exactFields");
  requireExactStrings(contract.extensions.view.extendedExactFields, ["name", "origins"], "extensions.view.extendedExactFields");
  if (
    contract.frames?.view?.epochField !== "origin_epoch" ||
    contract.frames?.view?.proofField !== "origin_proof" ||
    !Number.isSafeInteger(contract.frames.view.maxCoordinate) ||
    contract.frames.view.maxCoordinate <= 0 ||
    !Number.isSafeInteger(contract.frames.view.maxExtent) ||
    contract.frames.view.maxExtent <= 0
  )
    throw new Error("Invalid whiteboard contract: views require an epoch field and bounded coordinates");
  requireExactStrings(contract.extensions.view.orderedExactFields, ["name", "origins", "connection_id"], "extensions.view.orderedExactFields");
  requireExactStrings(contract.frames.view.leadFields, ["origin_connection_id", "origin_lead_stamp"], "frames.view.leadFields");
  if (contract.frames.welcome.leadershipField !== "view_leadership") throw new Error("Invalid whiteboard contract: welcome requires view_leadership");
  requireExactStrings(contract.frames?.view?.originFields, ["origin_participant_id", "origin_sequence"], "frames.view.originFields");
  requireExactStrings(contract.frames?.view?.clientExactFields, ["type", "x", "y", "width", "height", "bring"], "frames.view.clientExactFields");
  requireExactStrings(contract.frames?.view?.serverExactFields, ["type", "participant_id", "display_name", "x", "y", "width", "height", "bring", "occurred_at"], "frames.view.serverExactFields");
  requireExactStrings(contract.frames?.hello?.exactFields, ["type", "protocol", "token", "cursor"], "frames.hello.exactFields");
  requireExactStrings(contract.frames?.hello?.extendedExactFields, ["type", "protocol", "token", "cursor", "extensions"], "frames.hello.extendedExactFields");
  requireExactStrings(contract.frames?.welcome?.exactFields, ["type", "protocol", "participant_id", "participant_generation", "capabilities", "participant_capabilities", "scene_id", "revision", "can_draw"], "frames.welcome.exactFields");
  requireExactStrings(contract.frames?.welcome?.extendedExactFields, ["type", "protocol", "participant_id", "participant_generation", "capabilities", "participant_capabilities", "scene_id", "revision", "can_draw", "presenting"], "frames.welcome.extendedExactFields");

  requireExactStrings(contract.capabilities, ["drawWhiteboard", "manageWhiteboard"], "capabilities");
  requireExactStrings(contract.clientFrames, ["hello", "submit_update", "submit_update_part", "request_snapshot", "snapshot_ack", "clear", "set_draw_permission", "set_presentation", "cursor", "view", "ping"], "clientFrames");
  requireExactStrings(contract.serverFrames, ["welcome", "snapshot_page", "update", "update_part", "commit", "cursor", "view", "permission_updated", "presentation_updated", "reset_required", "operation_error", "pong"], "serverFrames");
  requireExactStrings(contract.receiptOperations, ["submit_update", "clear", "set_draw_permission", "set_presentation"], "receiptOperations");
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
    "multipartUpdateMaxParts",
    "multipartUpdateMaxItems",
    "multipartUpdateMaxBytes",
    "multipartUpdateTimeoutMs",
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
  if (Object.keys(contract.fileTransport ?? {}).length !== 1 || contract.fileTransport?.download !== "participant-bound-short-lived-url") {
    throw new Error("Invalid whiteboard contract: file transport must expose only participant-bound downloads");
  }

  const frameEntries = Object.values(contract.frames ?? {});
  if (frameEntries.length !== 19 || frameEntries.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new Error("Invalid whiteboard contract: all strict frame definitions are required");
  }
}

/** @param {unknown} actual @param {string[]} expected @param {string} field */
function requireExactStrings(actual, expected, field) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Invalid whiteboard contract: ${field} must match the frozen ordered set`);
  }
}
