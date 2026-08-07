// @ts-check

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { formatReference, parseReference } from "./reference.mjs";

export const FIXTURE_CLOCK = "2026-08-04T00:00:00.000Z";
export const FIXTURE_ENVIRONMENT = "localhost";
export const FIXTURE_STATES = Object.freeze(["live", "reconnecting", "stalled", "ended", "error", "failed", "export", "loading", "empty", "disconnected", "export-in-progress", "export-failed", "permission-denied"]);
export const VISUAL_VIEWPORTS = Object.freeze([1440, 1280, 1024]);
const HTML_STATES = new Set([...FIXTURE_STATES, "loading", "empty", "disconnected", "export-in-progress", "export-failed", "permission-denied"]);
export const LOADING_DELAY_MS = 30_000;
const DEFAULT_FILTER = Object.freeze({ schemaVersion: "DiagnosticFilter/v1" });

const OP_JOIN = "fixture-op-join";
const OP_JOIN_SECOND = "fixture-op-join-second";
const OP_CHAT = "fixture-op-chat";
const OP_REACTION = "fixture-op-reaction";
const OP_SCREEN = "fixture-op-screen";
const OP_MODERATION = "fixture-op-moderation";
const OP_RECOVER = "fixture-op-recover";
const OP_CLEANUP = "fixture-op-cleanup";
const OP_ARTIFACT = "fixture-op-artifact";
const ISSUE_STALL = "fixture-issue-stall";
const EVENT_CHAT = "fixture-event-chat";
const ENDED_STATES = new Set(["ended", "export", "export-in-progress", "export-failed"]);
const RECONNECTING_STATES = new Set(["reconnecting", "disconnected"]);
const ERROR_STATES = new Set(["error", "failed"]);
const EXPORT_STATES = new Set(["export", "export-in-progress", "export-failed"]);
const CHAT_FAILURE_STATES = new Set(["stalled", "error", "failed"]);
const MISSED_CHECKPOINT_STATES = new Set(["stalled", "failed"]);

const PROFILE_BY_VARIANT = Object.freeze({
  ended: { variant: "ended", ended: true, stalled: false, reconnecting: false, error: false, participantState: "left", operationState: "succeeded", issueState: "resolved", snapshotState: "ended" },
  reconnecting: { variant: "reconnecting", ended: false, stalled: false, reconnecting: true, error: false, participantState: "reconnecting", operationState: "retrying", issueState: "resolved", snapshotState: "live" },
  stalled: { variant: "stalled", ended: false, stalled: true, reconnecting: false, error: false, participantState: "joined", operationState: "stalled", issueState: "open", snapshotState: "live" },
  error: { variant: "error", ended: false, stalled: false, reconnecting: false, error: true, participantState: "joined", operationState: "failed", issueState: "open", snapshotState: "live" },
  normal: { variant: "normal", ended: false, stalled: false, reconnecting: false, error: false, participantState: "joined", operationState: "succeeded", issueState: "resolved", snapshotState: "live" },
});

const BRANCH_CONFIG_BY_STATE = Object.freeze({
  export: {
    cleanup: { state: "succeeded", attempts: 1, terminalAt: "2026-08-04T00:00:05.000Z", terminalCursor: 12 },
    recording: { state: "succeeded", attempts: 1, terminalAt: "2026-08-04T00:00:06.000Z", terminalCursor: 13 },
  },
  "export-in-progress": {
    cleanup: { state: "running", attempts: 1 },
    recording: { state: "running", attempts: 1 },
  },
  "export-failed": {
    cleanup: { state: "failed", attempts: 1, terminalAt: FIXTURE_CLOCK, terminalCursor: 12 },
    recording: { state: "running", attempts: 1 },
  },
});

const TERMINAL_OPERATION_CONFIG_BY_STATE = Object.freeze({
  ended: { cleanup: "succeeded", artifact: "succeeded" },
  export: { cleanup: "succeeded", artifact: "succeeded" },
  "export-in-progress": { cleanup: "succeeded", artifact: "succeeded" },
  "export-failed": { cleanup: "failed", artifact: "running" },
});

const PARTICIPANT_CONFIG_BY_VARIANT = Object.freeze({
  ended: { state: "left", visibility: "observable", visibilityGaps: [], leftAt: "2026-08-04T00:00:10.000Z" },
  reconnecting: { state: "reconnecting", visibility: "disconnected", visibilityGaps: ["client export paused while reconnecting"] },
  stalled: { state: "joined", visibility: "observable", visibilityGaps: [] },
  error: { state: "joined", visibility: "observable", visibilityGaps: [] },
  normal: { state: "joined", visibility: "observable", visibilityGaps: [] },
});

const ISSUE_CONFIG_BY_VARIANT = Object.freeze({
  ended: { kind: "checkpoint.missed", severity: "warning", state: "resolved", summary: "The required sender receipt missed its deadline", lastObservedAt: "2026-08-04T00:00:08.000Z", resolvedAt: "2026-08-04T00:00:08.000Z", missingCheckpoint: undefined, retryState: "none" },
  reconnecting: { kind: "checkpoint.missed", severity: "warning", state: "resolved", summary: "The required sender receipt missed its deadline", lastObservedAt: "2026-08-04T00:00:08.000Z", resolvedAt: "2026-08-04T00:00:08.000Z", missingCheckpoint: undefined, retryState: "retrying" },
  stalled: { kind: "checkpoint.missed", severity: "warning", state: "open", summary: "The required sender receipt missed its deadline", lastObservedAt: FIXTURE_CLOCK, missingCheckpoint: "sender_receipt", retryState: "none" },
  error: { kind: "transport.failure", severity: "error", state: "open", summary: "A transport boundary returned a safe failure", lastObservedAt: FIXTURE_CLOCK, missingCheckpoint: undefined, retryState: "none" },
  normal: { kind: "checkpoint.missed", severity: "warning", state: "resolved", summary: "The required sender receipt missed its deadline", lastObservedAt: "2026-08-04T00:00:08.000Z", resolvedAt: "2026-08-04T00:00:08.000Z", missingCheckpoint: undefined, retryState: "none" },
});

const EXPORT_JOB_STATE_BY_DIAGNOSTIC_STATE = Object.freeze({ "export-failed": "failed", "export-in-progress": "running" });
const BRIEF_FORMATS = new Set(["compact", "markdown"]);
const STATE_VARIANT_BY_STATE = Object.freeze({
  ended: "ended",
  export: "ended",
  "export-in-progress": "ended",
  "export-failed": "ended",
  reconnecting: "reconnecting",
  disconnected: "reconnecting",
  stalled: "stalled",
  error: "error",
  failed: "error",
});
const RUN_CONFIG_BY_VARIANT = Object.freeze({
  ended: { state: "ended", elapsedMilliseconds: 10_000, endedAt: "2026-08-04T00:00:10.000Z" },
  reconnecting: { state: "live", elapsedMilliseconds: 4_000 },
  stalled: { state: "live", elapsedMilliseconds: 4_000, firstMissingBoundary: { value: "sender_receipt" } },
  error: { state: "live", elapsedMilliseconds: 4_000 },
  normal: { state: "live", elapsedMilliseconds: 4_000 },
});

/**
 * A deterministic, content-free local server used by CLI, browser, and visual
 * proof tests. Its only credential is accepted in a request header and never
 * appears in a response, fixture HTML, or screenshot metadata.
 *
 * @param {{ port?: number; host?: string; environment?: "localhost"|"development"|"staging"; operatorCredential?: string }} [options]
 */
export async function createDiagnosticFixtureServer(options = {}) {
  const { environment, credential, host, port } = fixtureServerOptions(options);
  const streams = new Set();
  const connections = new Set();
  const jobs = new Map();
  const server = createServer((request, response) => handleRequest(request, response, { environment, credential, streams, jobs }));
  server.on("connection", (socket) => registerFixtureConnection(connections, socket));
  server.listen(port, host);
  await once(server, "listening");
  const url = `http://localhost:${fixtureServerPort(server)}`;
  return {
    server,
    url,
    environment,
    credential,
    references: Object.fromEntries(FIXTURE_STATES.map((state) => [state, fixtureReference(state, environment)])),
    reference: (state = "stalled", focus) => fixtureReference(state, environment, focus),
    fixture: (state = "stalled") => fixtureSnapshot(state),
    close: () => closeFixtureServer(server, streams, connections),
  };
}

/** @param {{ port?: number; host?: string; environment?: "localhost"|"development"|"staging"; operatorCredential?: string }} options */
function fixtureServerOptions(options) {
  return {
    port: optionOrDefault(options.port, 0),
    host: optionOrDefault(options.host, "127.0.0.1"),
    environment: optionOrDefault(options.environment, FIXTURE_ENVIRONMENT),
    credential: optionOrDefault(options.operatorCredential, "fixture-operator"),
  };
}

/** @template T @param {T|undefined|null} value @param {T} fallback */
function optionOrDefault(value, fallback) {
  return value ?? fallback;
}

/** @param {Set<import("node:net").Socket>} connections @param {import("node:net").Socket} socket */
function registerFixtureConnection(connections, socket) {
  connections.add(socket);
  socket.on("close", () => connections.delete(socket));
}

/** @param {import("node:http").Server} server */
function fixtureServerPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port");
  return address.port;
}

/** @param {import("node:http").Server} server @param {Set<import("node:http").ServerResponse>} streams @param {Set<import("node:net").Socket>} connections */
function closeFixtureServer(server, streams, connections) {
  for (const stream of streams) stream.destroy();
  for (const connection of connections) connection.destroy();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/**
 * @param {string} state
 * @param {string} environment
 * @param {{ kind: "op"|"issue"|"event"; id: string } | undefined} [focus]
 */
export function fixtureReference(state = "stalled", environment = FIXTURE_ENVIRONMENT, focus = undefined) {
  const diagnosticId = `fixture-${state}`;
  return formatReference({ version: 1, environment, diagnosticId, ...(focus ? { focus } : {}) });
}

/** @param {string} state */
export function fixtureSnapshot(state = "stalled") {
  if (!FIXTURE_STATES.includes(state)) throw new Error("Unknown diagnostic fixture state");
  if (state === "empty") return emptySnapshot();
  return cloneSnapshot(modifySnapshot(state, baseSnapshot(state)));
}

/** @param {string} state @param {Record<string, any>} snapshot */
function modifySnapshot(state, snapshot) {
  const modifier = SNAPSHOT_MODIFIERS[state];
  return modifier ? modifier(snapshot) : snapshot;
}

/** @param {Record<string, any>} snapshot */
function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

const SNAPSHOT_MODIFIERS = Object.freeze({
  "export-in-progress": applyExportInProgressSnapshot,
  "export-failed": applyExportFailedSnapshot,
});

/** @param {Record<string, any>} snapshot */
function applyExportInProgressSnapshot(snapshot) {
  const branches = snapshot.branches.map((branch) => ({ ...branch, state: "running", attempts: Math.max(branch.attempts, 1) }));
  snapshot.state = "ended";
  snapshot.epilogue.state = "live";
  snapshot.branches = branches;
  snapshot.epilogue.branches = branches;
  snapshot.epilogue.openBranchCount = branches.length;
  snapshot.epilogue.terminalBranchCount = 0;
  return snapshot;
}

/** @param {Record<string, any>} snapshot */
function applyExportFailedSnapshot(snapshot) {
  const branches = snapshot.branches.map((branch, index) => ({
    ...branch,
    state: index === 0 ? "failed" : "running",
    attempts: Math.max(branch.attempts, 1),
    ...(index === 0 ? { terminalAt: FIXTURE_CLOCK, terminalCursor: 12 } : {}),
  }));
  snapshot.state = "ended";
  snapshot.epilogue.state = "live";
  snapshot.branches = branches;
  snapshot.epilogue.branches = branches;
  snapshot.epilogue.openBranchCount = 1;
  snapshot.epilogue.terminalBranchCount = 1;
  return snapshot;
}

/**
 * Match the canonical contract fingerprint without importing the TypeScript
 * package into this standalone Node fixture process. The web client sends the
 * empty v1 filter by default, but every endpoint derives the value from the
 * request so filtered proof does not trip a synthetic fingerprint mismatch.
 *
 * @param {URL} url
 */
function filterFingerprint(url) {
  return sha256Canonical(parseFilter(url));
}

/** @param {URL} url */
function parseFilter(url) {
  const encoded = url.searchParams.get("filters");
  if (!encoded) return DEFAULT_FILTER;
  return normalizeFilter(encoded);
}

/** @param {string} encoded */
function normalizeFilter(encoded) {
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    // The API contract will reject a malformed filter upstream; keeping the
    // default here leaves the fixture useful for the browser's initial read.
    return DEFAULT_FILTER;
  }
  if (!isFilterObject(parsed)) return DEFAULT_FILTER;
  return { ...parsed, schemaVersion: "DiagnosticFilter/v1" };
}

/** @param {unknown} value */
function isFilterObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function sha256Canonical(value) {
  const canonical = (input) =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, canonical(input[key])]),
          )
        : input;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function emptySnapshot() {
  return {
    schemaVersion: "DiagnosticSnapshot/v1",
    reference: fixtureReference("empty"),
    environment: FIXTURE_ENVIRONMENT,
    state: "live",
    capturedAt: FIXTURE_CLOCK,
    committedCursor: 0,
    projectedCursor: 0,
    filterFingerprint: sha256Canonical(DEFAULT_FILTER),
    summary: { eventCount: 0, operationCount: 0, issueCount: 0, openIssueCount: 0, participantCount: 0 },
    operations: [],
    issues: [],
    branches: [],
    participants: [],
    run: { schemaVersion: "RunProjection/v1", state: "live", startedAt: FIXTURE_CLOCK, elapsedMilliseconds: 0, participantCount: 0, activeOperationCount: 0, openIssueCount: 0, participantLanes: [] },
    graph: { schemaVersion: "GraphProjection/v1", nodes: [], edges: [], summary: { nodeCount: 0, edgeCount: 0, activeCount: 0, failedCount: 0, unobservableCount: 0 } },
    flame: { schemaVersion: "FlameProjection/v1", lanes: [], buckets: [], heat: [] },
    epilogue: { schemaVersion: "EpilogueProjection/v1", state: "pending", branches: [], openBranchCount: 0, terminalBranchCount: 0 },
  };
}

function fixtureEvents(state) {
  const profile = stateProfile(state);
  return [...runFixtureEvents(state, profile), ...terminalFixtureEvents(state)];
}

/** @param {string} state @param {Record<string, any>} profile */
function runFixtureEvents(state, profile) {
  const reconnectCursor = profile.reconnecting ? 7 : 8;
  return [
    event("fixture-event-join", "participant.join", "succeeded", "sdk", 1, OP_JOIN, state),
    event("fixture-event-join-second", "participant.join", "succeeded", "sdk", 2, OP_JOIN_SECOND, state),
    event(EVENT_CHAT, "chat.send", CHAT_FAILURE_STATES.has(state) ? "started" : "succeeded", "sync", 3, OP_CHAT, state),
    event("fixture-event-reaction", "reaction.send", "succeeded", "sync", 4, OP_REACTION, state),
    event("fixture-event-screen", "screen.start", "succeeded", "sdk", 5, OP_SCREEN, state),
    event("fixture-event-moderation", "moderation.remove", "succeeded", "sync", 6, OP_MODERATION, state),
    event("fixture-event-reconnect", "sync.reconnect", profile.reconnecting ? "started" : "succeeded", "sync", reconnectCursor, OP_RECOVER, state),
  ];
}

/** @param {string} state */
function terminalFixtureEvents(state) {
  if (!ENDED_STATES.has(state)) return [];
  const failed = state === "export-failed";
  return [event("fixture-event-cleanup", "cleanup.complete", failed ? "failed" : "succeeded", "worker", 11, OP_CLEANUP, state), event("fixture-event-artifact", "artifact.commit", failed ? "started" : "succeeded", "worker", 12, OP_ARTIFACT, state)];
}

function fixtureGaps(state) {
  return RECONNECTING_STATES.has(state) ? [{ kind: "client_export", summary: "Client-side visibility paused during reconnect", reason: "not_observable", firstCursor: 7, lastCursor: 8 }] : [];
}

/**
 * @param {string} state
 */
function baseSnapshot(state) {
  const profile = stateProfile(state);
  const branches = fixtureBranches(state);
  const operations = fixtureOperations(state, profile);
  const issues = [fixtureIssue(state, profile)];
  const events = fixtureEvents(state);
  const participants = fixtureParticipants(profile, operations, issues);
  const graph = graphProjection(state, operations, issues);
  const flame = flameProjection(state, operations);
  const run = runProjection(profile, participants, operations, issues);
  const finalCursor = profile.ended ? 12 : 10;
  return {
    schemaVersion: "DiagnosticSnapshot/v1",
    reference: fixtureReference(state),
    environment: FIXTURE_ENVIRONMENT,
    state: profile.snapshotState,
    capturedAt: FIXTURE_CLOCK,
    committedCursor: finalCursor,
    projectedCursor: finalCursor,
    filterFingerprint: sha256Canonical(DEFAULT_FILTER),
    ...(profile.ended ? { runEndCursor: 10 } : {}),
    summary: { eventCount: events.length, operationCount: operations.length, issueCount: issues.length, openIssueCount: issues.filter((item) => item.state === "open").length, participantCount: participants.length },
    operations,
    issues,
    branches,
    participants,
    run,
    graph,
    flame,
    epilogue: epilogueProjection(state, branches, profile),
  };
}

/** @param {string} state */
function stateVariant(state) {
  return STATE_VARIANT_BY_STATE[state] ?? "normal";
}

/** @param {string} state */
function stateProfile(state) {
  return PROFILE_BY_VARIANT[stateVariant(state)];
}

/** @param {string} state */
function fixtureBranches(state) {
  const defaults = { cleanup: { state: state === "ended" ? "running" : "pending", attempts: 0 }, recording: { state: "pending", attempts: 0 } };
  const config = BRANCH_CONFIG_BY_STATE[state] ?? defaults;
  return [fixtureBranch("fixture-branch-cleanup", "cleanup", config.cleanup), fixtureBranch("fixture-branch-recording", "recording", config.recording)];
}

/** @param {string} id @param {string} kind @param {Record<string, unknown>} config */
function fixtureBranch(id, kind, config) {
  return {
    schemaVersion: "BranchDetail/v1",
    id,
    kind,
    state: config.state,
    leaseEndsAt: "2026-08-05T00:00:00.000Z",
    attempts: config.attempts,
    ...(config.terminalAt ? { terminalAt: config.terminalAt, terminalCursor: config.terminalCursor } : {}),
  };
}

/** @param {string} state @param {Record<string, any>} profile */
function fixtureOperations(state, profile) {
  const reconnectCursor = profile.reconnecting ? 7 : 8;
  const reconnectAttempt = profile.reconnecting ? 2 : 1;
  const operations = [
    operation(OP_JOIN, "participant.join", "succeeded", "sdk", 1, 1, state),
    operation(OP_JOIN_SECOND, "participant.join", "succeeded", "sdk", 1, 2, state),
    operation(OP_CHAT, "chat.send", profile.operationState, "sync", 2, 3, state),
    operation(OP_REACTION, "reaction.send", "succeeded", "sync", 1, 4, state),
    operation(OP_SCREEN, "screen.start", "succeeded", "sdk", 1, 5, state),
    operation(OP_MODERATION, "moderation.remove", "succeeded", "sync", 1, 6, state),
    operation(OP_RECOVER, "sync.reconnect", profile.reconnecting ? "retrying" : "succeeded", "sync", reconnectAttempt, reconnectCursor, state),
  ];
  return [...operations, ...terminalOperations(state)];
}

/** @param {string} state */
function terminalOperations(state) {
  const config = TERMINAL_OPERATION_CONFIG_BY_STATE[state];
  if (!config) return [];
  return [operation(OP_CLEANUP, "cleanup.complete", config.cleanup, "worker", 1, 11, state), operation(OP_ARTIFACT, "artifact.commit", config.artifact, "worker", 1, 12, state)];
}

/** @param {string} state @param {Record<string, any>} profile */
function fixtureIssue(state, profile) {
  const config = ISSUE_CONFIG_BY_VARIANT[profile.variant];
  return {
    schemaVersion: "IssueDetail/v1",
    id: ISSUE_STALL,
    reference: fixtureReference(state, FIXTURE_ENVIRONMENT, { kind: "issue", id: ISSUE_STALL }),
    operationId: OP_CHAT,
    ...config,
    firstObservedAt: "2026-08-04T00:00:03.000Z",
    lastConfirmedCheckpoint: "durable_commit",
  };
}

/** @param {Record<string, any>} profile @param {unknown[]} operations @param {unknown[]} issues */
function fixtureParticipants(profile, operations, issues) {
  return ["fixture-participant-1", "fixture-participant-2"].map((participantId, index) => fixtureParticipant(participantId, index, profile, operations, issues));
}

/** @param {string} participantId @param {number} index @param {Record<string, any>} profile @param {unknown[]} operations @param {unknown[]} issues */
function fixtureParticipant(participantId, index, profile, operations, issues) {
  const config = PARTICIPANT_CONFIG_BY_VARIANT[profile.variant];
  const identity = [
    { identityKind: "user", operationCount: operations.length - 1, issueCount: issues.length },
    { identityKind: "guest", operationCount: 1, issueCount: 0 },
  ][index];
  return {
    schemaVersion: "ParticipantProjection/v1",
    participantId,
    anonymousLabel: `Participant ${index + 1}`,
    identityKind: identity.identityKind,
    state: config.state,
    joinedAt: "2026-08-04T00:00:00.000Z",
    ...participantLifecycleFields(config),
    visibility: config.visibility,
    visibilityGaps: config.visibilityGaps,
    operationCount: identity.operationCount,
    issueCount: identity.issueCount,
    display: { label: { value: `Participant ${index + 1}` }, rawIdentity: { unknownReason: "redacted" } },
  };
}

/** @param {Record<string, unknown>} config */
function participantLifecycleFields(config) {
  return config.leftAt ? { leftAt: config.leftAt } : {};
}

/** @param {Record<string, any>} profile @param {unknown[]} participants @param {unknown[]} operations @param {unknown[]} issues */
function runProjection(profile, participants, operations, issues) {
  const config = RUN_CONFIG_BY_VARIANT[profile.variant];
  return {
    schemaVersion: "RunProjection/v1",
    state: config.state,
    startedAt: "2026-08-04T00:00:00.000Z",
    ...(config.endedAt ? { endedAt: config.endedAt } : {}),
    elapsedMilliseconds: config.elapsedMilliseconds,
    participantCount: participants.length,
    activeOperationCount: operations.filter((item) => ["running", "retrying", "stalled"].includes(item.state)).length,
    openIssueCount: issues.filter((item) => item.state === "open").length,
    latestConfirmedBoundary: { value: "durable_commit" },
    ...(config.firstMissingBoundary ? { firstMissingBoundary: config.firstMissingBoundary } : {}),
    participantLanes: [
      { participantId: participants[0].participantId, operationIds: operations.filter((item) => item.id !== OP_JOIN_SECOND).map((item) => item.id), state: profile.participantState },
      { participantId: participants[1].participantId, operationIds: [OP_JOIN_SECOND], state: profile.participantState },
    ],
  };
}

/** @param {string} state @param {unknown[]} branches @param {Record<string, any>} profile */
function epilogueProjection(state, branches, profile) {
  const complete = state === "export";
  return {
    schemaVersion: "EpilogueProjection/v1",
    state: complete ? "complete" : profile.ended ? "live" : "pending",
    ...(complete ? { completedAt: "2026-08-04T00:00:06.000Z", latestTerminalCursor: 13 } : {}),
    branches,
    openBranchCount: branches.filter((item) => ["pending", "running"].includes(item.state)).length,
    terminalBranchCount: branches.filter((item) => ["succeeded", "failed", "cancelled", "timed_out"].includes(item.state)).length,
  };
}

/** @param {string} id @param {string} kind @param {string} state @param {string} source @param {number} attempt @param {number} cursor */
function operation(id, kind, state, source, attempt, cursor, diagnosticState) {
  return {
    schemaVersion: "OperationDetail/v1",
    id,
    reference: fixtureReference(diagnosticState, FIXTURE_ENVIRONMENT, { kind: "op", id }),
    diagnosticReference: fixtureReference(diagnosticState),
    kind,
    expectationVersion: 1,
    state,
    attempt,
    startedAt: "2026-08-04T00:00:00.000Z",
    ...operationLifecycle(state),
    checkpoints: operationCheckpoints(state, cursor),
    source,
    releaseId: "chalk-fixture-2026-08-04",
    sourceCommit: "fixturecommit20260804",
  };
}

const OPERATION_RECEIPT_MISSED = Object.freeze({ state: "missed", unknownReason: "not_observable" });

/** @param {string} state */
function operationLifecycle(state) {
  return state === "succeeded" ? { endedAt: "2026-08-04T00:00:02.000Z", durationMilliseconds: 2_000 } : {};
}

/** @param {string} state @param {number} cursor */
function operationCheckpoints(state, cursor) {
  const receipt = MISSED_CHECKPOINT_STATES.has(state) ? OPERATION_RECEIPT_MISSED : { state: "observed", evidenceCursor: cursor };
  return [
    { key: "intent", class: "required", displayOrder: 0, state: "observed", evidenceCursor: cursor - 1 },
    { key: "durable_commit", class: "required", displayOrder: 1, state: "observed", evidenceCursor: cursor },
    { key: "sender_receipt", class: "required", displayOrder: 2, ...receipt },
  ];
}

/** @param {string} id @param {string} name @param {string} state @param {string} source @param {number} cursor @param {string} operationRef */
function event(id, name, state, source, cursor, operationRef, diagnosticState) {
  const draft = {
    version: 1,
    eventId: id,
    producerOperationRef: operationRef,
    producerSequence: cursor,
    occurredAt: FIXTURE_CLOCK,
    source,
    name,
    phase: state === "succeeded" ? "succeeded" : "started",
    state,
    attributes: { action: name, cursor },
  };
  return { ...draft, diagnosticId: `fixture-${diagnosticState}`, cursor, receivedAt: FIXTURE_CLOCK, fingerprint: sha256Canonical(draft) };
}

/** @param {string} state @param {unknown[]} operations @param {unknown[]} issues */
function graphProjection(state, operations, issues) {
  const issueState = issues.some((item) => item.state === "open") ? "stalled" : "healthy";
  const nodes = [
    { id: "ui", kind: "ui", label: "Debugger", state: "active", operationCount: operations.length, issueCount: 0 },
    { id: "sdk", kind: "sdk", label: "Client SDK", state: "active", operationCount: 2, issueCount: 0 },
    { id: "sync", kind: "sync", label: "Sync", state: issueState, operationCount: 1, issueCount: issues.length },
    { id: "worker", kind: "worker", label: "Epilogue worker", state: state === "export" ? "healthy" : "unknown", operationCount: 0, issueCount: 0 },
  ];
  const edges = [
    { id: "ui-sdk", from: "ui", to: "sdk", state: "active", operationIds: ["fixture-op-join"], issueIds: [] },
    { id: "sdk-sync", from: "sdk", to: "sync", state: issueState, operationIds: ["fixture-op-chat", "fixture-op-recover"], issueIds: issues.map((item) => item.id) },
  ];
  return {
    schemaVersion: "GraphProjection/v1",
    nodes,
    edges,
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      activeCount: nodes.filter((item) => ["active", "stalled"].includes(item.state)).length,
      failedCount: nodes.filter((item) => item.state === "failed").length,
      unobservableCount: nodes.filter((item) => item.state === "unobservable").length,
    },
  };
}

/** @param {string} state @param {unknown[]} operations */
function flameProjection(state, operations) {
  return {
    schemaVersion: "FlameProjection/v1",
    lanes: [
      { id: "sdk", label: "Client SDK", source: "sdk", bars: operations.filter((item) => item.source === "sdk").map((item) => ({ id: `${item.id}-bar`, operationId: item.id, startAt: item.startedAt, endAt: item.endedAt, state: item.state, attempt: item.attempt })) },
      { id: "sync", label: "Sync", source: "sync", bars: operations.filter((item) => item.source === "sync").map((item) => ({ id: `${item.id}-bar`, operationId: item.id, startAt: item.startedAt, endAt: item.endedAt, state: item.state, attempt: item.attempt })) },
    ],
    buckets: [{ startAt: "2026-08-04T00:00:00.000Z", endAt: "2026-08-04T00:00:05.000Z", count: operations.length, failedCount: operations.filter((item) => ["failed", "stalled"].includes(item.state)).length, heat: state === "stalled" ? 0.8 : 0.2 }],
    heat: [],
  };
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {{ environment: string; credential: string; streams: Set<import("node:http").ServerResponse>; jobs: Map<string, Record<string, unknown>> }} config
 */
function handleRequest(request, response, config) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (handlePublicRoute(response, url)) return;
  const parsed = parseDiagnosticRequest(request, url, config);
  if (parsed.error) return sendJSON(response, parsed.error.status, parsed.error.body);
  return handleDiagnosticRequest(response, parsed);
}

/** @param {import("node:http").ServerResponse} response @param {URL} url */
function handlePublicRoute(response, url) {
  if (url.pathname === "/health") {
    sendJSON(response, 200, { ok: true, clock: FIXTURE_CLOCK });
    return true;
  }
  if (url.pathname === "/") {
    sendHTML(response, requestedHTMLState(url));
    return true;
  }
  if (url.pathname.startsWith("/_internal/episode-diagnostics/")) return false;
  sendJSON(response, 404, { code: "not_found" });
  return true;
}

/** @param {URL} url */
function requestedHTMLState(url) {
  return url.searchParams.get("state") ?? "stalled";
}

/** @param {import("node:http").IncomingMessage} request @param {URL} url @param {{ environment: string; credential: string; streams: Set<import("node:http").ServerResponse>; jobs: Map<string, Record<string, unknown>> }} config */
function parseDiagnosticRequest(request, url, config) {
  const path = diagnosticPath(url.pathname);
  if (!path) return { error: { status: 404, body: { code: "not_found" } } };
  const parsedReference = parseDiagnosticReference(path.encodedReference);
  if (parsedReference.error) return { error: parsedReference.error };
  const { reference, referenceValue } = parsedReference;
  const accessError = diagnosticAccessError(request, reference, config);
  if (accessError) return { error: accessError };
  return { request, url, reference, referenceValue, suffix: path.suffix, state: diagnosticState(reference.diagnosticId), streams: config.streams, jobs: config.jobs };
}

/** @param {import("node:http").IncomingMessage} request @param {Record<string, any>} reference @param {{ environment: string; credential: string }} config */
function diagnosticAccessError(request, reference, config) {
  if (reference.environment !== config.environment) return { status: 404, body: { code: "not_found" } };
  if (request.headers.authorization !== `Bearer ${config.credential}`) return { status: 403, body: { code: "unauthorized" } };
  return undefined;
}

/** @param {string} encodedReference */
function parseDiagnosticReference(encodedReference) {
  try {
    const referenceValue = decodeURIComponent(encodedReference);
    return { referenceValue, reference: parseReference(referenceValue) };
  } catch {
    return { error: { status: 400, body: { code: "malformed" } } };
  }
}

/** @param {string} pathname */
function diagnosticPath(pathname) {
  const prefix = "/_internal/episode-diagnostics/";
  if (!pathname.startsWith(prefix)) return undefined;
  const remaining = pathname.slice(prefix.length);
  const slash = remaining.indexOf("/");
  return { encodedReference: slash === -1 ? remaining : remaining.slice(0, slash), suffix: slash === -1 ? "" : remaining.slice(slash + 1) };
}

/** @param {string} diagnosticId */
function diagnosticState(diagnosticId) {
  return diagnosticId.startsWith("fixture-") ? diagnosticId.slice("fixture-".length) : diagnosticId;
}

/** @param {import("node:http").ServerResponse} response @param {{ url: URL; reference: Record<string, any>; referenceValue: string; suffix: string; state: string }} requestContext */
function handleDiagnosticRequest(response, requestContext) {
  const { state } = requestContext;
  const stateError = diagnosticStateError(state);
  if (stateError) return sendJSON(response, stateError.status, stateError.body);
  if (state === "loading") return handleLoadingRequest(response, requestContext.url, state);
  return handleFixtureRequest(response, requestContext);
}

const DIAGNOSTIC_STATE_ERRORS = Object.freeze({
  expired: { status: 410, body: { code: "expired" } },
  ambiguous: { status: 409, body: { code: "ambiguous" } },
  "permission-denied": { status: 403, body: { code: "permission_denied", message: "Diagnostic operator access is denied for this fixture" } },
  error: { status: 503, body: { code: "upstream_failure", message: "Diagnostic evidence upstream failed for this fixture" } },
  failed: { status: 500, body: { code: "diagnostic_failed", message: "Diagnostic evidence failed for this fixture" } },
});

/** @param {string} state */
function diagnosticStateError(state) {
  if (DIAGNOSTIC_STATE_ERRORS[state]) return DIAGNOSTIC_STATE_ERRORS[state];
  if (!FIXTURE_STATES.includes(state)) return { status: 404, body: { code: "not_found" } };
  return undefined;
}

/** @param {import("node:http").ServerResponse} response @param {URL} url @param {string} state */
function handleLoadingRequest(response, url, state) {
  if (url.searchParams.get("fixture_mode") === "probe") {
    sendJSON(response, 200, fixtureSnapshot(state));
    return;
  }
  setTimeout(() => {
    if (!response.writableEnded && !response.destroyed) sendJSON(response, 200, fixtureSnapshot(state));
  }, LOADING_DELAY_MS);
}

/** @param {import("node:http").ServerResponse} response @param {{ url: URL; reference: Record<string, any>; referenceValue: string; suffix: string; state: string }} requestContext */
function handleFixtureRequest(response, requestContext) {
  const { url, reference, referenceValue, state, suffix } = requestContext;
  const snapshot = fixtureSnapshot(state);
  const events = fixtureEvents(state);
  const gaps = fixtureGaps(state);
  const fingerprint = filterFingerprint(url);
  snapshot.environment = reference.environment;
  snapshot.reference = referenceValue;
  snapshot.filterFingerprint = fingerprint;
  const focus = reference.focus;
  const focused = focus ? resolveFixtureFocus(snapshot, events, focus) : undefined;
  if (focus && !focused) return sendJSON(response, 404, { code: "not_found" });
  return handleFixtureRoute(response, { ...requestContext, snapshot, events, gaps, fingerprint, focus, focused });
}

const FIXTURE_ROUTE_HANDLERS = Object.freeze({ brief: handleBriefRoute, stream: handleStreamRoute, events: handleEventsRoute, operations: handleOperationsRoute });

/** @param {import("node:http").ServerResponse} response @param {Record<string, any>} context */
function handleFixtureRoute(response, context) {
  const handler = FIXTURE_ROUTE_HANDLERS[context.suffix];
  if (handler) return handler(response, context);
  if (handleExportRoute(response, context)) return true;
  if (handleProjectionRoute(response, context)) return true;
  return sendDefaultFixture(response, context);
}

/** @param {import("node:http").ServerResponse} response @param {Record<string, any>} context */
function handleBriefRoute(response, context) {
  const format = context.url.searchParams.get("format") ?? "compact";
  if (!BRIEF_FORMATS.has(format)) {
    sendJSON(response, 400, { code: "invalid_format" });
    return true;
  }
  const brief = briefFixture(context.snapshot, context.events, context.gaps, context.referenceValue, context.focused);
  sendJSON(response, 200, { schemaVersion: "AgentBriefResponse/v1", format, brief, ...(format === "markdown" ? { markdown: markdownFixture(brief) } : {}) });
  return true;
}

/** @param {import("node:http").ServerResponse} response @param {Record<string, any>} context */
function handleStreamRoute(response, context) {
  sendFixtureStream(response, context.referenceValue, context.state, context.url, context.fingerprint, context.streams);
  return true;
}

/** @param {import("node:http").ServerResponse} response @param {Record<string, any>} context */
function handleEventsRoute(response, context) {
  sendJSON(response, 200, pageFixture(context.referenceValue, context.events, "events", context.url, context.fingerprint));
  return true;
}

/** @param {import("node:http").ServerResponse} response @param {Record<string, any>} context */
function handleOperationsRoute(response, context) {
  sendJSON(response, 200, pageFixture(context.referenceValue, context.snapshot.operations, "operations", context.url, context.fingerprint));
  return true;
}

/** @param {import("node:http").ServerResponse} response @param {Record<string, any>} context */
function handleExportRoute(response, context) {
  if (context.suffix === "export-jobs" && context.request.method === "POST") {
    createFixtureExportJob(response, context.referenceValue, context.state, context.jobs);
    return true;
  }
  if (context.suffix.startsWith("export-jobs/")) {
    readFixtureExportJob(response, context.referenceValue, context.state, context.suffix.slice("export-jobs/"), context.request.method, context.jobs);
    return true;
  }
  return false;
}

const PROJECTION_SUFFIXES = new Set(["graph", "flame", "participants", "epilogue"]);

/** @param {import("node:http").ServerResponse} response @param {Record<string, any>} context */
function handleProjectionRoute(response, context) {
  if (!PROJECTION_SUFFIXES.has(context.suffix)) return false;
  sendJSON(response, 200, { [context.suffix]: context.snapshot[context.suffix], committedCursor: context.snapshot.committedCursor, projectedCursor: context.snapshot.projectedCursor });
  return true;
}

/** @param {import("node:http").ServerResponse} response @param {Record<string, any>} context */
function sendDefaultFixture(response, context) {
  if (!context.focused) return sendJSON(response, 200, { kind: "diagnostic", reference: context.referenceValue, snapshot: context.snapshot });
  const kind = { op: "operation", issue: "issue", event: "event" }[context.focus.kind] ?? context.focus.kind;
  return sendJSON(response, 200, { kind, reference: context.referenceValue, snapshot: context.snapshot, [kind]: context.focused });
}

/** @param {Record<string, unknown>} snapshot @param {{ kind: string; id: string }} focus */
function resolveFixtureFocus(snapshot, events, focus) {
  const values = { op: snapshot.operations, issue: snapshot.issues, event: events }[focus.kind] ?? events;
  return values.find((item) => item.id === focus.id || item.eventId === focus.id || item.cursor === Number(focus.id));
}

/** @param {string} reference @param {unknown[]} values @param {string} key @param {URL} url @param {string} fingerprint */
function pageFixture(reference, values, key, url, fingerprint) {
  const pagination = fixturePagination(values, key, url);
  return {
    schemaVersion: key === "events" ? "DiagnosticEventPage/v1" : "DiagnosticOperationPage/v1",
    reference,
    [key]: pagination.selected,
    committedCursor: pagination.finalCursor,
    projectedCursor: pagination.finalCursor,
    ...(pagination.hasMore ? { nextCursor: pagination.lastSelectedCursor } : {}),
    hasMore: pagination.hasMore,
    filterFingerprint: fingerprint,
  };
}

/** @param {unknown[]} values @param {string} key @param {URL} url */
function fixturePagination(values, key, url) {
  const { after, limit } = fixturePageOptions(url);
  const cursorOf = (item) => fixtureCursor(item, key);
  const ordered = [...values].sort((left, right) => cursorOf(left) - cursorOf(right));
  const selected = ordered.filter((item) => cursorOf(item) > after).slice(0, limit);
  const lastSelectedCursor = selected.length ? cursorOf(selected.at(-1)) : after;
  return {
    selected,
    lastSelectedCursor,
    hasMore: ordered.some((item) => cursorOf(item) > lastSelectedCursor),
    finalCursor: Math.max(0, ...ordered.map(cursorOf)),
  };
}

/** @param {URL} url */
function fixturePageOptions(url) {
  return {
    after: Number(url.searchParams.get("after") ?? url.searchParams.get("after_cursor") ?? 0),
    limit: Math.min(1_000, Math.max(1, Number(url.searchParams.get("limit") ?? 100))),
  };
}

/** @param {Record<string, any>} item @param {string} key */
function fixtureCursor(item, key) {
  if (key === "events") return Number(item.cursor ?? 0);
  return Math.max(0, ...(item.checkpoints ?? []).map((checkpoint) => Number(checkpoint.evidenceCursor ?? 0)));
}

/** @param {Record<string, unknown>} snapshot @param {string} reference @param {Record<string, unknown>|undefined} focus */
function briefFixture(snapshot, events, gaps, reference, focus) {
  const open = snapshot.issues.filter((item) => item.state === "open").length;
  return {
    schemaVersion: "AgentBrief/v1",
    version: 1,
    reference,
    ...(focus ? { focusedReference: reference } : {}),
    captureTime: FIXTURE_CLOCK,
    selectedCursor: snapshot.projectedCursor,
    observedSummary: `${snapshot.state} Episode Diagnostic with ${snapshot.operations.length} operations, ${open} open issues, and ${events.length} retained Events.`,
    environment: FIXTURE_ENVIRONMENT,
    resolverCommand: `pnpm trace:inspect ${reference} --format agent`,
    releaseCommits: [{ release: "chalk-fixture-2026-08-04", sourceCommit: "fixturecommit20260804" }],
    visibleGaps: gaps,
    episodeSummary: `Run state is ${snapshot.run.state} with ${snapshot.summary.participantCount} Participants and ${snapshot.run.elapsedMilliseconds} milliseconds elapsed.`,
    issues: snapshot.issues,
    operations: snapshot.operations,
    branches: snapshot.branches,
    counts: { events: events.length, operations: snapshot.operations.length, issues: snapshot.issues.length, openIssues: open, branches: snapshot.branches.length },
    omissions: ["Content, credentials, raw protocol payloads, and provider-private work are omitted."],
  };
}

/** @param {Record<string, unknown>} brief */
function markdownFixture(brief) {
  return [
    `# Episode Diagnostic Agent Brief`,
    "",
    `Reference: \`${brief.reference}\``,
    "",
    "## Summary",
    "",
    brief.observedSummary,
    "",
    "## Issues",
    "",
    ...brief.issues.map((issue) => `- ${issue.severity} · ${issue.state} · ${issue.summary}`),
    "",
    "## Omissions",
    "",
    ...brief.omissions.map((item) => `- ${item}`),
  ].join("\n");
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string} reference
 * @param {string} state
 * @param {URL} url
 * @param {string} fingerprint
 * @param {Set<import("node:http").ServerResponse>} streams
 */
function sendFixtureStream(response, reference, state, url, fingerprint, streams) {
  const after = Number(url.searchParams.get("after") ?? 0);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
  streams.add(response);
  response.on("close", () => streams.delete(response));
  const control = { schemaVersion: "DiagnosticStreamControl/v1", heartbeatIntervalSeconds: 15, maxConnectionSeconds: 1_800, afterCursor: after, filterFingerprint: fingerprint, maxPendingDeltas: 100 };
  response.write(`id: ${after}\nevent: control\ndata: ${JSON.stringify(control)}\n\n`);
  if (["reconnecting", "disconnected"].includes(state)) {
    const gapCursor = Math.max(1, after);
    const gap = { schemaVersion: "DiagnosticStreamDelta/v1", reference, cursor: gapCursor, kind: "gap", filterFingerprint: fingerprint, gap: { fromCursor: gapCursor, toCursor: gapCursor, reason: "not_observable" } };
    response.write(`id: ${gapCursor}\nevent: gap\ndata: ${JSON.stringify(gap)}\n\n`);
    const close = { schemaVersion: "DiagnosticStreamClose/v1", reason: "server_shutdown", resumableCursor: 10, refillRequired: true };
    response.write(`id: 10\nevent: close\ndata: ${JSON.stringify(close)}\n\n`);
    response.end();
  }
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string} reference
 * @param {string} state
 * @param {Map<string, Record<string, unknown>>} jobs
 */
function createFixtureExportJob(response, reference, state, jobs) {
  const jobId = `fixture-export-${state}`;
  const exportState = EXPORT_JOB_STATE_BY_DIAGNOSTIC_STATE[state] ?? "succeeded";
  const job = {
    schemaVersion: "ExportJob/v1",
    jobId,
    reference,
    state: exportState,
    createdAt: FIXTURE_CLOCK,
    leaseEndsAt: "2026-08-04T00:30:00.000Z",
    ...exportJobSuccessFields(exportState, reference),
    ...exportJobFailureFields(exportState),
  };
  jobs.set(jobId, job);
  return sendJSON(response, 200, job);
}

/** @param {string} exportState @param {string} reference */
function exportJobSuccessFields(exportState, reference) {
  if (exportState !== "succeeded") return {};
  return { downloadExpiresAt: "2026-08-04T01:00:00.000Z", cursorTo: 10, manifest: { schemaVersion: "DiagnosticBundle/v1", reference, cursorFrom: 0, cursorTo: 10, eventCount: 3, omissionCount: 1, checksums: { manifest: "sha256:fixture" }, compressed: true } };
}

/** @param {string} exportState */
function exportJobFailureFields(exportState) {
  return exportState === "failed" ? { errorReason: "not_available" } : {};
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string} reference
 * @param {string} state
 * @param {string} requestedJobId
 * @param {string|undefined} method
 * @param {Map<string, Record<string, unknown>>} jobs
 */
function readFixtureExportJob(response, reference, state, requestedJobId, method, jobs) {
  const jobId = fixtureJobId(requestedJobId);
  const existing = jobs.get(jobId) ?? defaultFixtureExportJob(jobId, reference, state);
  return respondToFixtureExportJob(response, reference, requestedJobId, method, jobs, jobId, existing);
}

/** @param {string} requestedJobId */
function fixtureJobId(requestedJobId) {
  return decodeURIComponent(requestedJobId.split("/")[0] ?? requestedJobId);
}

/** @param {import("node:http").ServerResponse} response @param {string} reference @param {string} requestedJobId @param {string|undefined} method @param {Map<string, Record<string, unknown>>} jobs @param {string} jobId @param {Record<string, unknown>} existing */
function respondToFixtureExportJob(response, reference, requestedJobId, method, jobs, jobId, existing) {
  if (method === "DELETE") {
    return cancelFixtureExportJob(response, jobId, existing, jobs);
  }
  if (requestedJobId.endsWith("/download")) return sendJSON(response, 200, fixtureDownload(reference, jobId, existing));
  jobs.set(jobId, existing);
  return sendJSON(response, 200, existing);
}

/** @param {string} jobId @param {string} reference @param {string} state */
function defaultFixtureExportJob(jobId, reference, state) {
  const exportState = EXPORT_JOB_STATE_BY_DIAGNOSTIC_STATE[state] ?? "succeeded";
  return {
    schemaVersion: "ExportJob/v1",
    jobId,
    reference,
    state: exportState,
    createdAt: FIXTURE_CLOCK,
    leaseEndsAt: "2026-08-04T00:30:00.000Z",
    ...exportJobFailureFields(exportState),
  };
}

/** @param {import("node:http").ServerResponse} response @param {string} jobId @param {Record<string, unknown>} existing @param {Map<string, Record<string, unknown>>} jobs */
function cancelFixtureExportJob(response, jobId, existing, jobs) {
  const cancelled = { ...existing, state: "cancelled" };
  jobs.set(jobId, cancelled);
  return sendJSON(response, 200, cancelled);
}

/** @param {string} reference @param {string} jobId @param {Record<string, unknown>} existing */
function fixtureDownload(reference, jobId, existing) {
  return { schemaVersion: "DiagnosticBundle/v1", reference, jobId, state: existing.state, omissionCount: 1 };
}

/** @param {import("node:http").ServerResponse} response @param {number} status @param {unknown} body */
function sendJSON(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

/** @param {import("node:http").ServerResponse} response @param {string} state */
function sendHTML(response, state) {
  const selected = HTML_STATES.has(state) ? state : "stalled";
  const encodedState = JSON.stringify(selected);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Episode Diagnostics Fixture</title><style>html{font-family:system-ui,sans-serif;background:#f7f6f2;color:#0c0e12}body{margin:0;padding:32px}main{max-width:960px;margin:auto;background:#fff;border:1px solid #d7d5cf;border-radius:12px;padding:24px}code{font-family:ui-monospace,monospace}</style></head><body data-diagnostic-state="${selected}" data-fixed-clock="${FIXTURE_CLOCK}" data-font-ready="false"><main><h1>Episode Diagnostic</h1><p data-summary>Fixture state: <strong>${selected}</strong></p><p><code data-reference>chalkdiag:v1:localhost:fixture-${selected}</code></p><nav aria-label="Views"><a href="?state=${selected}&view=run">Run</a> <a href="?state=${selected}&view=graph">Graph</a> <a href="?state=${selected}&view=trace">Trace</a> <a href="?state=${selected}&view=flame">Flame</a> <a href="?state=${selected}&view=participants">Participants</a> <a href="?state=${selected}&view=epilogue">Epilogue</a></nav></main><script>window.__diagnosticFixture={state:${encodedState},clock:${JSON.stringify(FIXTURE_CLOCK)},dataReady:true};document.fonts?.ready.finally(()=>{document.body.dataset.fontReady='true';document.body.dataset.ready='true'});</script></body></html>`;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(html) });
  response.end(html);
}
