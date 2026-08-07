import { EVENT_SOURCES, MAX_PAGE_SIZE, UNKNOWN_REASONS } from "./allowlists.js";
import { validateDiagnosticBranch } from "./details.js";
import { fingerprintCanonicalValue } from "./events.js";
import { validateDiagnosticReferenceField } from "./references.js";
import { checkDateTime, checkEnum, checkSafeToken, finishValidation, isFiniteNumber, isNonNegativeInteger, isRecord, isString, parseOrThrow, pushUnknownKeys, requireString, type ValidationIssue, type ValidationResult } from "./runtime.js";
import { isForbiddenDiagnosticValue } from "./safety.js";
import type { AgentBriefQueryV1, DiagnosticFilterV1, DiagnosticStreamCloseV1, DiagnosticStreamControlV1, DiagnosticStreamStatusV1, EpilogueProjectionV1, FlameProjectionV1, GraphProjectionV1, ParticipantProjectionV1, RunProjectionV1, SafeUnknownReason, TraceSpanLookupV1 } from "./types.js";

const checkId = (value: unknown, path: string, issues: ValidationIssue[], max = 128): value is string => {
  if (isString(value) && value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@+/=-]*$/.test(value)) return true;
  issues.push({ path, message: "expected a bounded safe ID" });
  return false;
};

const PARTICIPANT_PROJECTION_KEYS = ["schemaVersion", "participantId", "anonymousLabel", "identityKind", "state", "joinedAt", "leftAt", "visibility", "visibilityGaps", "operationCount", "issueCount", "display"] as const;
const PARTICIPANT_DISPLAY_KEYS = ["label", "rawIdentity"] as const;
const DISPLAY_KEYS = ["value", "unknownReason"] as const;
const RUN_PROJECTION_KEYS = ["schemaVersion", "state", "startedAt", "endedAt", "elapsedMilliseconds", "participantCount", "activeOperationCount", "openIssueCount", "latestConfirmedBoundary", "firstMissingBoundary", "participantLanes"] as const;
const RUN_LANE_KEYS = ["participantId", "operationIds", "state"] as const;
const GRAPH_PROJECTION_KEYS = ["schemaVersion", "nodes", "edges", "summary"] as const;
const GRAPH_NODE_KEYS = ["id", "kind", "label", "state", "operationCount", "issueCount"] as const;
const GRAPH_EDGE_KEYS = ["id", "from", "to", "state", "operationIds", "issueIds"] as const;
const GRAPH_SUMMARY_KEYS = ["nodeCount", "edgeCount", "activeCount", "failedCount", "unobservableCount"] as const;
const FLAME_PROJECTION_KEYS = ["schemaVersion", "lanes", "buckets", "heat"] as const;
const FLAME_LANE_KEYS = ["id", "label", "source", "bars"] as const;
const FLAME_BAR_KEYS = ["id", "operationId", "startAt", "endAt", "state", "attempt", "retryGroup"] as const;
const FLAME_BUCKET_KEYS = ["startAt", "endAt", "count", "failedCount", "heat"] as const;
const FLAME_HEAT_KEYS = ["laneId", "startAt", "endAt", "intensity"] as const;
const EPILOGUE_PROJECTION_KEYS = ["schemaVersion", "state", "completedAt", "branches", "openBranchCount", "terminalBranchCount", "latestTerminalCursor"] as const;
const checkLabel = (value: unknown, path: string, issues: ValidationIssue[]): value is string => {
  if (isString(value) && !isForbiddenDiagnosticValue(value) && /^Participant [0-9]{1,4}$/.test(value)) return true;
  if (isString(value) && isForbiddenDiagnosticValue(value)) issues.push({ path, message: "human-readable value is forbidden" });
  issues.push({ path, message: "labels must be anonymous Participant N labels" });
  return false;
};
const boundedStringArray = (value: unknown, path: string, issues: ValidationIssue[], max = 128): string[] => {
  if (!Array.isArray(value) || value.length > MAX_PAGE_SIZE || value.some((item) => !isString(item) || item.length > max || isForbiddenDiagnosticValue(item))) {
    issues.push({ path, message: "expected a bounded string array" });
    return [];
  }
  return [...(value as string[])];
};

const checkBoundedArray = (value: unknown, path: string, max: number, message: string, issues: ValidationIssue[]): boolean => {
  if (!Array.isArray(value) || value.length > max) {
    issues.push({ path, message });
    return false;
  }
  return true;
};

type DisplayValue = Readonly<{ value?: string; unknownReason?: SafeUnknownReason }>;

const validateDisplayValue = (value: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  if (value.value !== undefined && (!isString(value.value) || value.value.length > 256)) issues.push({ path: `${path}.value`, message: "display value is too long" });
  if (isString(value.value) && isForbiddenDiagnosticValue(value.value)) issues.push({ path: `${path}.value`, message: "human-readable value is forbidden" });
};

const checkHumanReadable = (value: unknown, path: string, issues: ValidationIssue[], maxLength: number): value is string => {
  if (!isString(value) || value.length > maxLength) {
    issues.push({ path, message: "human-readable value is invalid" });
    return false;
  }
  if (isForbiddenDiagnosticValue(value)) {
    issues.push({ path, message: "human-readable value is forbidden" });
    return false;
  }
  return true;
};

const validateDisplayUnknownReason = (value: Record<string, unknown>, path: string, issues: ValidationIssue[]): boolean => value.unknownReason === undefined || checkEnum(value.unknownReason, UNKNOWN_REASONS, `${path}.unknownReason`, issues);

const validateDisplay = (value: unknown, path: string, issues: ValidationIssue[], allowValue = true): DisplayValue => {
  if (!isRecord(value)) {
    issues.push({ path, message: "expected display value" });
    return {};
  }
  pushUnknownKeys(value, DISPLAY_KEYS, issues, path);
  validateDisplayValue(value, path, issues);
  if (!allowValue && value.value !== undefined) issues.push({ path: `${path}.value`, message: "raw identity values are not retained" });
  if (!validateDisplayUnknownReason(value, path, issues)) return {};
  if (value.value === undefined && value.unknownReason === undefined) issues.push({ path, message: "display value must state a value or unknown reason" });
  return { ...(value.value === undefined ? {} : { value: value.value as string }), ...(value.unknownReason === undefined ? {} : { unknownReason: value.unknownReason as SafeUnknownReason }) };
};

const copyDefinedFields = <K extends string>(input: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, unknown>> => {
  const fields: Partial<Record<K, unknown>> = {};
  for (const key of keys) {
    if (input[key] !== undefined) fields[key] = input[key];
  }
  return fields;
};

export const validateParticipantProjection = (input: unknown): ValidationResult<ParticipantProjectionV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected Participant projection" }] };
  pushUnknownKeys(input, PARTICIPANT_PROJECTION_KEYS, issues, "$");
  if (input.schemaVersion !== "ParticipantProjection/v1") issues.push({ path: "$.schemaVersion", message: "expected ParticipantProjection/v1" });
  const participantId = requireString(input, "participantId", issues);
  if (participantId !== undefined) checkId(participantId, "$.participantId", issues);
  const anonymousLabel = requireString(input, "anonymousLabel", issues);
  if (anonymousLabel !== undefined) checkLabel(anonymousLabel, "$.anonymousLabel", issues);
  if (!checkEnum(input.identityKind, ["user", "agent", "guest", "unknown"] as const, "$.identityKind", issues)) return { ok: false, issues };
  if (!checkEnum(input.state, ["joined", "reconnecting", "left", "unknown"] as const, "$.state", issues)) return { ok: false, issues };
  for (const key of ["joinedAt", "leftAt"] as const) if (input[key] !== undefined) checkDateTime(input[key], `$.${key}`, issues);
  if (!checkEnum(input.visibility, ["observable", "not_observable", "disconnected"] as const, "$.visibility", issues)) return { ok: false, issues };
  const visibilityGaps = boundedStringArray(input.visibilityGaps, "$.visibilityGaps", issues, 160);
  const countsValid = validateParticipantCounts(input, issues);
  const display = validateParticipantDisplay(input, issues);
  if (!participantId || !anonymousLabel || !countsValid || !display) return { ok: false, issues };
  return finishValidation(
    {
      schemaVersion: "ParticipantProjection/v1",
      participantId,
      anonymousLabel,
      identityKind: input.identityKind as ParticipantProjectionV1["identityKind"],
      state: input.state as ParticipantProjectionV1["state"],
      ...(input.joinedAt === undefined ? {} : { joinedAt: input.joinedAt as string }),
      ...(input.leftAt === undefined ? {} : { leftAt: input.leftAt as string }),
      visibility: input.visibility as ParticipantProjectionV1["visibility"],
      visibilityGaps,
      operationCount: input.operationCount as number,
      issueCount: input.issueCount as number,
      display,
    },
    issues,
  );
};
export const parseParticipantProjection = (input: unknown): ParticipantProjectionV1 => parseOrThrow(validateParticipantProjection(input), "Invalid ParticipantProjection/v1");

const validateParticipantCounts = (input: Record<string, unknown>, issues: ValidationIssue[]): boolean => {
  let valid = true;
  for (const key of ["operationCount", "issueCount"] as const) {
    if (!isNonNegativeInteger(input[key])) {
      issues.push({ path: `$.${key}`, message: `${key} must be non-negative` });
      valid = false;
    }
  }
  return valid;
};

const validateParticipantDisplay = (input: Record<string, unknown>, issues: ValidationIssue[]): ParticipantProjectionV1["display"] | undefined => {
  if (!isRecord(input.display)) {
    issues.push({ path: "$.display", message: "display is required" });
    return undefined;
  }
  pushUnknownKeys(input.display, PARTICIPANT_DISPLAY_KEYS, issues, "$.display");
  const label = validateDisplay(input.display.label, "$.display.label", issues);
  if (isRecord(input.display.label) && input.display.label.value !== undefined) checkLabel(input.display.label.value, "$.display.label.value", issues);
  return {
    label,
    rawIdentity: validateDisplay(input.display.rawIdentity, "$.display.rawIdentity", issues, false),
  };
};

export const validateRunProjection = (input: unknown): ValidationResult<RunProjectionV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected Run projection" }] };
  pushUnknownKeys(input, RUN_PROJECTION_KEYS, issues, "$");
  if (input.schemaVersion !== "RunProjection/v1") issues.push({ path: "$.schemaVersion", message: "expected RunProjection/v1" });
  if (!checkEnum(input.state, ["live", "ended", "complete", "expired"] as const, "$.state", issues)) return { ok: false, issues };
  const startedAt = input.startedAt;
  checkDateTime(startedAt, "$.startedAt", issues);
  if (input.endedAt !== undefined) checkDateTime(input.endedAt, "$.endedAt", issues);
  const countersValid = validateRunCounters(input, issues);
  const boundaries = validateRunBoundaries(input, issues);
  const participantLanes = validateRunParticipantLanes(input, issues);
  if (!startedAt || !countersValid || !participantLanes) return { ok: false, issues };
  return finishValidation(
    {
      schemaVersion: "RunProjection/v1",
      state: input.state as RunProjectionV1["state"],
      startedAt: startedAt as string,
      ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt as string }),
      elapsedMilliseconds: input.elapsedMilliseconds as number,
      participantCount: input.participantCount as number,
      activeOperationCount: input.activeOperationCount as number,
      openIssueCount: input.openIssueCount as number,
      ...boundaries,
      participantLanes,
    },
    issues,
  );
};
export const parseRunProjection = (input: unknown): RunProjectionV1 => parseOrThrow(validateRunProjection(input), "Invalid RunProjection/v1");

const validateRunCounters = (input: Record<string, unknown>, issues: ValidationIssue[]): boolean => {
  const valid = ["elapsedMilliseconds", "participantCount", "activeOperationCount", "openIssueCount"].every((key) => isNonNegativeInteger(input[key]));
  if (!valid) issues.push({ path: "$.", message: "run counters must be non-negative" });
  return valid;
};

const validateRunBoundaries = (input: Record<string, unknown>, issues: ValidationIssue[]): Partial<Pick<RunProjectionV1, "latestConfirmedBoundary" | "firstMissingBoundary">> => {
  const boundaries: { latestConfirmedBoundary?: RunProjectionV1["latestConfirmedBoundary"]; firstMissingBoundary?: RunProjectionV1["firstMissingBoundary"] } = {};
  for (const key of ["latestConfirmedBoundary", "firstMissingBoundary"] as const) {
    if (input[key] !== undefined) boundaries[key] = validateDisplay(input[key], `$.${key}`, issues);
  }
  return boundaries;
};

const validateRunParticipantLanes = (input: Record<string, unknown>, issues: ValidationIssue[]): RunProjectionV1["participantLanes"] | undefined => {
  if (!Array.isArray(input.participantLanes)) {
    issues.push({ path: "$.participantLanes", message: "participantLanes must be bounded" });
    return undefined;
  }
  if (input.participantLanes.length > MAX_PAGE_SIZE) issues.push({ path: "$.participantLanes", message: "participantLanes must be bounded" });
  const participantLanes: Array<RunProjectionV1["participantLanes"][number]> = [];
  for (const [index, lane] of input.participantLanes.entries()) {
    const parsed = parseRunParticipantLane(lane, index, issues);
    if (parsed) participantLanes.push(parsed);
  }
  return participantLanes;
};

const parseRunParticipantLane = (lane: unknown, index: number, issues: ValidationIssue[]): RunProjectionV1["participantLanes"][number] | undefined => {
  if (!isRecord(lane)) {
    issues.push({ path: `$.participantLanes[${index}]`, message: "expected lane" });
    return undefined;
  }
  pushUnknownKeys(lane, RUN_LANE_KEYS, issues, `$.participantLanes[${index}]`);
  const participantPath = `$.participantLanes[${index}].participantId`;
  const participantIdValid = checkId(lane.participantId, participantPath, issues);
  const state = lane.state;
  const stateValid = checkSafeToken(state, `$.participantLanes[${index}].state`, issues, 64) && checkHumanReadable(state, `$.participantLanes[${index}].state`, issues, 64);
  const operationIds = boundedStringArray(lane.operationIds, `$.participantLanes[${index}].operationIds`, issues);
  if (!participantIdValid || !stateValid) return undefined;
  return { participantId: lane.participantId as string, operationIds, state };
};

export const validateGraphProjection = (input: unknown): ValidationResult<GraphProjectionV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected Graph projection" }] };
  pushUnknownKeys(input, GRAPH_PROJECTION_KEYS, issues, "$");
  if (input.schemaVersion !== "GraphProjection/v1") issues.push({ path: "$.schemaVersion", message: "expected GraphProjection/v1" });
  checkBoundedArray(input.nodes, "$.nodes", 256, "nodes must contain at most 256 entries", issues);
  checkBoundedArray(input.edges, "$.edges", 512, "edges must contain at most 512 entries", issues);
  const nodes = validateGraphNodes(input.nodes, issues);
  const edges = validateGraphEdges(input.edges, issues);
  const summary = validateGraphSummary(input.summary, issues);
  if (!nodes || !edges || !summary) return { ok: false, issues };
  return finishValidation({ schemaVersion: "GraphProjection/v1", nodes, edges, summary }, issues);
};
export const parseGraphProjection = (input: unknown): GraphProjectionV1 => parseOrThrow(validateGraphProjection(input), "Invalid GraphProjection/v1");

const validateGraphNodes = (value: unknown, issues: ValidationIssue[]): GraphProjectionV1["nodes"] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const nodes: Array<GraphProjectionV1["nodes"][number]> = [];
  for (const [index, node] of value.entries()) {
    const parsed = parseGraphNode(node, index, issues);
    if (parsed) nodes.push(parsed);
  }
  return nodes;
};

const parseGraphNode = (node: unknown, index: number, issues: ValidationIssue[]): GraphProjectionV1["nodes"][number] | undefined => {
  if (!isRecord(node)) {
    issues.push({ path: `$.nodes[${index}]`, message: "expected node" });
    return undefined;
  }
  pushUnknownKeys(node, GRAPH_NODE_KEYS, issues, `$.nodes[${index}]`);
  const id = node.id;
  const label = node.label;
  const identityValid = validateGraphNodeIdentity(id, label, index, issues);
  if (!validateGraphNodeEnums(node, index, issues)) return undefined;
  const countersValid = validateGraphNodeCounters(node, index, issues);
  if (!identityValid || !countersValid || !isString(label)) return undefined;
  return { id: id as string, kind: node.kind as GraphProjectionV1["nodes"][number]["kind"], label, state: node.state as GraphProjectionV1["nodes"][number]["state"], operationCount: node.operationCount as number, issueCount: node.issueCount as number };
};

const validateGraphNodeIdentity = (id: unknown, label: unknown, index: number, issues: ValidationIssue[]): boolean => {
  const idValid = checkId(id, `$.nodes[${index}].id`, issues);
  const labelValid = checkHumanReadable(label, `$.nodes[${index}].label`, issues, 128);
  if (!idValid || !labelValid) issues.push({ path: `$.nodes[${index}]`, message: "node ID/label invalid" });
  return idValid && labelValid;
};

const validateGraphNodeEnums = (node: Record<string, unknown>, index: number, issues: ValidationIssue[]): boolean => {
  if (!checkEnum(node.kind, ["ui", "sdk", "access", "api", "sync", "database", "media", "sfu", "worker", "provider", "unknown"] as const, `$.nodes[${index}].kind`, issues)) return false;
  return checkEnum(node.state, ["healthy", "active", "stalled", "failed", "unobservable", "unknown"] as const, `$.nodes[${index}].state`, issues);
};

const validateGraphNodeCounters = (node: Record<string, unknown>, index: number, issues: ValidationIssue[]): boolean => {
  let valid = true;
  for (const key of ["operationCount", "issueCount"] as const) {
    if (!isNonNegativeInteger(node[key])) {
      issues.push({ path: `$.nodes[${index}].${key}`, message: `${key} must be non-negative` });
      valid = false;
    }
  }
  return valid;
};

const validateGraphEdges = (value: unknown, issues: ValidationIssue[]): GraphProjectionV1["edges"] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const edges: Array<GraphProjectionV1["edges"][number]> = [];
  for (const [index, edge] of value.entries()) {
    const parsed = parseGraphEdge(edge, index, issues);
    if (parsed) edges.push(parsed);
  }
  return edges;
};

const parseGraphEdge = (edge: unknown, index: number, issues: ValidationIssue[]): GraphProjectionV1["edges"][number] | undefined => {
  if (!isRecord(edge)) {
    issues.push({ path: `$.edges[${index}]`, message: "expected edge" });
    return undefined;
  }
  pushUnknownKeys(edge, GRAPH_EDGE_KEYS, issues, `$.edges[${index}]`);
  for (const key of ["id", "from", "to"] as const) checkId(edge[key], `$.edges[${index}].${key}`, issues);
  if (!checkEnum(edge.state, ["healthy", "active", "stalled", "failed", "unobservable", "unknown"] as const, `$.edges[${index}].state`, issues)) return undefined;
  const operationIds = boundedStringArray(edge.operationIds, `$.edges[${index}].operationIds`, issues);
  const issueIds = boundedStringArray(edge.issueIds, `$.edges[${index}].issueIds`, issues);
  if (!isString(edge.id) || !isString(edge.from) || !isString(edge.to)) return undefined;
  return { id: edge.id, from: edge.from, to: edge.to, state: edge.state as GraphProjectionV1["edges"][number]["state"], operationIds, issueIds };
};

const validateGraphSummary = (value: unknown, issues: ValidationIssue[]): GraphProjectionV1["summary"] | undefined => {
  if (!isRecord(value)) {
    issues.push({ path: "$.summary", message: "summary is required" });
    issues.push({ path: "$.summary", message: "summary counters must be non-negative" });
    return undefined;
  }
  pushUnknownKeys(value, GRAPH_SUMMARY_KEYS, issues, "$.summary");
  const keys = ["nodeCount", "edgeCount", "activeCount", "failedCount", "unobservableCount"] as const;
  const valid = keys.every((key) => isNonNegativeInteger(value[key]));
  if (!valid) {
    issues.push({ path: "$.summary", message: "summary counters must be non-negative" });
    return undefined;
  }
  return { nodeCount: value.nodeCount as number, edgeCount: value.edgeCount as number, activeCount: value.activeCount as number, failedCount: value.failedCount as number, unobservableCount: value.unobservableCount as number };
};

export const validateFlameProjection = (input: unknown): ValidationResult<FlameProjectionV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected Flame projection" }] };
  pushUnknownKeys(input, FLAME_PROJECTION_KEYS, issues, "$");
  if (input.schemaVersion !== "FlameProjection/v1") issues.push({ path: "$.schemaVersion", message: "expected FlameProjection/v1" });
  checkBoundedArray(input.lanes, "$.lanes", 256, "lanes must be bounded", issues);
  checkBoundedArray(input.buckets, "$.buckets", MAX_PAGE_SIZE, "buckets must be bounded", issues);
  checkBoundedArray(input.heat, "$.heat", MAX_PAGE_SIZE, "heat must be bounded", issues);
  const lanes = validateFlameLanes(input.lanes, issues);
  const buckets = validateFlameBuckets(input.buckets, issues);
  const heat = validateFlameHeat(input.heat, issues);
  if (!lanes || !buckets || !heat) return { ok: false, issues };
  return finishValidation({ schemaVersion: "FlameProjection/v1", lanes, buckets, heat }, issues);
};
export const parseFlameProjection = (input: unknown): FlameProjectionV1 => parseOrThrow(validateFlameProjection(input), "Invalid FlameProjection/v1");

const validateFlameLanes = (value: unknown, issues: ValidationIssue[]): FlameProjectionV1["lanes"] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const lanes: Array<FlameProjectionV1["lanes"][number]> = [];
  for (const [index, lane] of value.entries()) {
    const parsed = parseFlameLane(lane, index, issues);
    if (parsed) lanes.push(parsed);
  }
  return lanes;
};

const parseFlameLane = (lane: unknown, index: number, issues: ValidationIssue[]): FlameProjectionV1["lanes"][number] | undefined => {
  if (!isRecord(lane)) {
    issues.push({ path: `$.lanes[${index}]`, message: "expected lane" });
    return undefined;
  }
  pushUnknownKeys(lane, FLAME_LANE_KEYS, issues, `$.lanes[${index}]`);
  const id = lane.id;
  const label = lane.label;
  const idValid = checkId(id, `$.lanes[${index}].id`, issues);
  const labelValid = checkHumanReadable(label, `$.lanes[${index}].label`, issues, 128);
  if (!checkEnum(lane.source, EVENT_SOURCES, `$.lanes[${index}].source`, issues)) return undefined;
  const bars = validateFlameBars(lane.bars, index, issues);
  if (!idValid || !labelValid || !bars) return undefined;
  return { id, label, source: lane.source as FlameProjectionV1["lanes"][number]["source"], bars };
};

const validateFlameBars = (value: unknown, laneIndex: number, issues: ValidationIssue[]): FlameProjectionV1["lanes"][number]["bars"] | undefined => {
  const path = `$.lanes[${laneIndex}].bars`;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "bars must be bounded" });
    return undefined;
  }
  if (value.length > MAX_PAGE_SIZE) issues.push({ path, message: "bars must be bounded" });
  const bars: Array<FlameProjectionV1["lanes"][number]["bars"][number]> = [];
  for (const [barIndex, bar] of value.entries()) {
    const parsed = parseFlameBar(bar, laneIndex, barIndex, issues);
    if (parsed) bars.push(parsed);
  }
  return bars;
};

const parseFlameBar = (bar: unknown, laneIndex: number, barIndex: number, issues: ValidationIssue[]): FlameProjectionV1["lanes"][number]["bars"][number] | undefined => {
  const path = `$.lanes[${laneIndex}].bars[${barIndex}]`;
  if (!isRecord(bar)) {
    issues.push({ path, message: "expected bar" });
    return undefined;
  }
  pushUnknownKeys(bar, FLAME_BAR_KEYS, issues, path);
  const barId = bar.id;
  if (!checkId(barId, `${path}.id`, issues)) return undefined;
  validateFlameBarTimes(bar, path, issues);
  if (!validateFlameBarState(bar, path, issues)) return undefined;
  validateFlameBarMetadata(bar, path, issues);
  if (!isString(bar.startAt)) return undefined;
  return buildFlameBar(bar, barId);
};

const validateFlameBarTimes = (bar: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  checkDateTime(bar.startAt, `${path}.startAt`, issues);
  if (bar.endAt !== undefined) checkDateTime(bar.endAt, `${path}.endAt`, issues);
};

const validateFlameBarState = (bar: Record<string, unknown>, path: string, issues: ValidationIssue[]): boolean => checkEnum(bar.state, ["running", "retrying", "succeeded", "failed", "stalled", "cancelled", "timed_out"] as const, `${path}.state`, issues);

const validateFlameBarMetadata = (bar: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  if (bar.operationId !== undefined) checkId(bar.operationId, `${path}.operationId`, issues);
  if (bar.attempt !== undefined && !isNonNegativeInteger(bar.attempt)) issues.push({ path: `${path}.attempt`, message: "attempt must be non-negative" });
  if (bar.retryGroup !== undefined) checkId(bar.retryGroup, `${path}.retryGroup`, issues);
};

const buildFlameBar = (bar: Record<string, unknown>, barId: string): FlameProjectionV1["lanes"][number]["bars"][number] => {
  const result = { id: barId } as {
    id: string;
    operationId?: string;
    startAt: string;
    endAt?: string;
    state: FlameProjectionV1["lanes"][number]["bars"][number]["state"];
    attempt?: number;
    retryGroup?: string;
  };
  if (bar.operationId !== undefined) result.operationId = bar.operationId as string;
  result.startAt = bar.startAt as string;
  if (bar.endAt !== undefined) result.endAt = bar.endAt as string;
  result.state = bar.state as FlameProjectionV1["lanes"][number]["bars"][number]["state"];
  if (bar.attempt !== undefined) result.attempt = bar.attempt as number;
  if (bar.retryGroup !== undefined) result.retryGroup = bar.retryGroup as string;
  return result;
};

const validateFlameBuckets = (value: unknown, issues: ValidationIssue[]): FlameProjectionV1["buckets"] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const buckets: Array<FlameProjectionV1["buckets"][number]> = [];
  for (const [index, bucket] of value.entries()) {
    const parsed = parseFlameBucket(bucket, index, issues);
    if (parsed) buckets.push(parsed);
  }
  return buckets;
};

const parseFlameBucket = (bucket: unknown, index: number, issues: ValidationIssue[]): FlameProjectionV1["buckets"][number] | undefined => {
  const path = `$.buckets[${index}]`;
  if (!isRecord(bucket)) {
    issues.push({ path, message: "expected bucket" });
    return undefined;
  }
  pushUnknownKeys(bucket, FLAME_BUCKET_KEYS, issues, path);
  validateFlameBucketTimes(bucket, path, issues);
  validateFlameBucketCounts(bucket, path, issues);
  validateFlameBucketHeat(bucket, path, issues);
  if (!isString(bucket.startAt) || !isString(bucket.endAt) || !isNonNegativeInteger(bucket.count) || !isNonNegativeInteger(bucket.failedCount) || !isFiniteNumber(bucket.heat)) return undefined;
  return { startAt: bucket.startAt, endAt: bucket.endAt, count: bucket.count, failedCount: bucket.failedCount, heat: bucket.heat };
};

const validateFlameBucketTimes = (bucket: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  for (const key of ["startAt", "endAt"] as const) checkDateTime(bucket[key], `${path}.${key}`, issues);
};

const validateFlameBucketCounts = (bucket: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  for (const key of ["count", "failedCount"] as const) {
    if (!isNonNegativeInteger(bucket[key])) issues.push({ path: `${path}.${key}`, message: `${key} must be non-negative` });
  }
};

const validateFlameBucketHeat = (bucket: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  if (!isFiniteNumber(bucket.heat) || bucket.heat < 0 || bucket.heat > 1) issues.push({ path: `${path}.heat`, message: "heat must be between 0 and 1" });
};

const validateFlameHeat = (value: unknown, issues: ValidationIssue[]): FlameProjectionV1["heat"] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const heat: Array<FlameProjectionV1["heat"][number]> = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseFlameHeat(item, index, issues);
    if (parsed) heat.push(parsed);
  }
  return heat;
};

const parseFlameHeat = (item: unknown, index: number, issues: ValidationIssue[]): FlameProjectionV1["heat"][number] | undefined => {
  const path = `$.heat[${index}]`;
  if (!isRecord(item)) {
    issues.push({ path, message: "expected heat item" });
    return undefined;
  }
  pushUnknownKeys(item, FLAME_HEAT_KEYS, issues, path);
  if (!checkId(item.laneId, `${path}.laneId`, issues)) return undefined;
  validateFlameHeatTimes(item, path, issues);
  validateFlameHeatIntensity(item, path, issues);
  if (!isString(item.startAt) || !isString(item.endAt) || !isFiniteNumber(item.intensity)) return undefined;
  return { laneId: item.laneId, startAt: item.startAt, endAt: item.endAt, intensity: item.intensity };
};

const validateFlameHeatTimes = (item: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  for (const key of ["startAt", "endAt"] as const) checkDateTime(item[key], `${path}.${key}`, issues);
};

const validateFlameHeatIntensity = (item: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  if (!isFiniteNumber(item.intensity) || item.intensity < 0 || item.intensity > 1) issues.push({ path: `${path}.intensity`, message: "intensity must be between 0 and 1" });
};

const validateEpilogueBranches = (value: unknown, issues: ValidationIssue[]): EpilogueProjectionV1["branches"] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_PAGE_SIZE) {
    issues.push({ path: "$.branches", message: "branches must be bounded" });
    return undefined;
  }
  const branches: EpilogueProjectionV1["branches"][number][] = [];
  for (const [index, branch] of value.entries()) {
    const result = validateDiagnosticBranch(branch, `$.branches[${index}]`);
    if (result.ok) branches.push(result.value);
    else issues.push(...result.issues);
  }
  return branches;
};

const validateEpilogueCounts = (input: Record<string, unknown>, issues: ValidationIssue[]): boolean => {
  const countsValid = isNonNegativeInteger(input.openBranchCount) && isNonNegativeInteger(input.terminalBranchCount);
  if (!countsValid) issues.push({ path: "$.", message: "branch counts must be non-negative" });
  if (input.latestTerminalCursor !== undefined && !isNonNegativeInteger(input.latestTerminalCursor)) issues.push({ path: "$.latestTerminalCursor", message: "latestTerminalCursor must be non-negative" });
  return countsValid;
};

const buildEpilogueProjection = (input: Record<string, unknown>, branches: EpilogueProjectionV1["branches"]): EpilogueProjectionV1 => ({
  schemaVersion: "EpilogueProjection/v1",
  state: input.state as EpilogueProjectionV1["state"],
  ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt as string }),
  branches,
  openBranchCount: input.openBranchCount as number,
  terminalBranchCount: input.terminalBranchCount as number,
  ...(input.latestTerminalCursor === undefined ? {} : { latestTerminalCursor: input.latestTerminalCursor as number }),
});

export const validateEpilogueProjection = (input: unknown): ValidationResult<EpilogueProjectionV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected Epilogue projection" }] };
  pushUnknownKeys(input, EPILOGUE_PROJECTION_KEYS, issues, "$");
  if (input.schemaVersion !== "EpilogueProjection/v1") issues.push({ path: "$.schemaVersion", message: "expected EpilogueProjection/v1" });
  if (!checkEnum(input.state, ["pending", "live", "complete", "expired"] as const, "$.state", issues)) return { ok: false, issues };
  if (input.completedAt !== undefined) checkDateTime(input.completedAt, "$.completedAt", issues);
  const branches = validateEpilogueBranches(input.branches, issues);
  const countsValid = validateEpilogueCounts(input, issues);
  if (branches === undefined || !countsValid) return { ok: false, issues };
  return finishValidation(buildEpilogueProjection(input, branches), issues);
};
export const parseEpilogueProjection = (input: unknown): EpilogueProjectionV1 => parseOrThrow(validateEpilogueProjection(input), "Invalid EpilogueProjection/v1");

const canonicalize = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalize)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonicalize(value[key])]),
        )
      : value;
export const canonicalizeDiagnosticFilter = (filter: DiagnosticFilterV1): string => JSON.stringify(canonicalize(filter));
export const fingerprintDiagnosticFilter = (filter: DiagnosticFilterV1 | Omit<DiagnosticFilterV1, "schemaVersion">): string => {
  const value = "schemaVersion" in filter ? filter : { schemaVersion: "DiagnosticFilter/v1" as const, ...filter };
  return fingerprintCanonicalValue(value);
};
export const filterFingerprint = fingerprintDiagnosticFilter;

export const validateDiagnosticFilter = (input: unknown): ValidationResult<DiagnosticFilterV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected filter object" }] };
  if (input.schemaVersion !== "DiagnosticFilter/v1") issues.push({ path: "$.schemaVersion", message: "expected DiagnosticFilter/v1" });
  validateDiagnosticFilterIds(input, issues);
  if (input.spanId !== undefined && input.traceId === undefined) issues.push({ path: "$.spanId", message: "spanId requires traceId" });
  if (input.source !== undefined) checkEnum(input.source, EVENT_SOURCES, "$.source", issues);
  if (input.issueState !== undefined) checkEnum(input.issueState, ["open", "resolved"] as const, "$.issueState", issues);
  validateDiagnosticFilterCursors(input, issues);
  validateDiagnosticFilterTimes(input, issues);
  return finishValidation({ schemaVersion: "DiagnosticFilter/v1", ...copyDefinedFields(input, DIAGNOSTIC_FILTER_OUTPUT_KEYS) } as DiagnosticFilterV1, issues);
};
export const parseDiagnosticFilter = (input: unknown): DiagnosticFilterV1 => parseOrThrow(validateDiagnosticFilter(input), "Invalid DiagnosticFilter/v1");

const DIAGNOSTIC_FILTER_ID_KEYS = ["participantId", "operationKind", "releaseId", "journeyId", "traceId", "spanId", "requestId", "commandId", "providerId"] as const;
const DIAGNOSTIC_FILTER_OUTPUT_KEYS = ["participantId", "source", "operationKind", "state", "issueState", "releaseId", "journeyId", "traceId", "spanId", "requestId", "commandId", "providerId", "fromCursor", "toCursor", "fromTime", "toTime"] as const;

const validateDiagnosticFilterIds = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  for (const key of DIAGNOSTIC_FILTER_ID_KEYS) {
    if (input[key] !== undefined) checkId(input[key], `$.${key}`, issues, 160);
  }
};

const validateDiagnosticFilterCursors = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  for (const key of ["fromCursor", "toCursor"] as const) {
    if (input[key] !== undefined && !isNonNegativeInteger(input[key])) issues.push({ path: `$.${key}`, message: `${key} must be non-negative` });
  }
};

const validateDiagnosticFilterTimes = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  for (const key of ["fromTime", "toTime"] as const) {
    if (input[key] !== undefined) checkDateTime(input[key], `$.${key}`, issues);
  }
};

export const validateTraceSpanLookup = (input: unknown): ValidationResult<TraceSpanLookupV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected trace/span lookup" }] };
  const traceId = requireString(input, "traceId", issues);
  const spanId = requireString(input, "spanId", issues);
  if (traceId !== undefined && !/^[0-9a-f]{32}$/i.test(traceId)) issues.push({ path: "$.traceId", message: "traceId must be 32 hex characters" });
  if (spanId !== undefined && !/^[0-9a-f]{16}$/i.test(spanId)) issues.push({ path: "$.spanId", message: "spanId must be 16 hex characters" });
  if (!traceId || !spanId) return { ok: false, issues };
  return finishValidation({ traceId, spanId }, issues);
};
export const parseTraceSpanLookup = (input: unknown): TraceSpanLookupV1 => parseOrThrow(validateTraceSpanLookup(input), "Invalid paired trace/span lookup");

export const validateAgentBriefQuery = (input: unknown): ValidationResult<AgentBriefQueryV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected AgentBrief query" }] };
  if (input.schemaVersion !== "AgentBriefQuery/v1") issues.push({ path: "$.schemaVersion", message: "expected AgentBriefQuery/v1" });
  const reference = validateDiagnosticReferenceField(input, "reference", issues);
  if (!checkEnum(input.format, ["compact", "markdown"] as const, "$.format", issues)) return { ok: false, issues };
  validateAgentBriefBounds(input, issues);
  if (input.branchId !== undefined) checkId(input.branchId, "$.branchId", issues);
  if (!reference) return { ok: false, issues };
  return finishValidation({ schemaVersion: "AgentBriefQuery/v1", reference, ...copyDefinedFields(input, ["cursor"] as const), format: input.format as AgentBriefQueryV1["format"], ...copyDefinedFields(input, ["aroundSeconds", "branchId"] as const) } as AgentBriefQueryV1, issues);
};
export const parseAgentBriefQuery = (input: unknown): AgentBriefQueryV1 => parseOrThrow(validateAgentBriefQuery(input), "Invalid AgentBriefQuery/v1");

const validateAgentBriefBounds = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  for (const key of ["cursor", "aroundSeconds"] as const) {
    if (input[key] !== undefined && (!isNonNegativeInteger(input[key]) || input[key] > (key === "aroundSeconds" ? 3_600 : Number.MAX_SAFE_INTEGER))) issues.push({ path: `$.${key}`, message: `${key} is out of bounds` });
  }
};

export const validateStreamControl = (input: unknown): ValidationResult<DiagnosticStreamControlV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected stream control" }] };
  if (input.schemaVersion !== "DiagnosticStreamControl/v1") issues.push({ path: "$.schemaVersion", message: "expected DiagnosticStreamControl/v1" });
  if (!isNonNegativeInteger(input.heartbeatIntervalSeconds) || input.heartbeatIntervalSeconds < 1 || input.heartbeatIntervalSeconds > 60) issues.push({ path: "$.heartbeatIntervalSeconds", message: "heartbeat interval is out of bounds" });
  if (!isNonNegativeInteger(input.maxConnectionSeconds) || input.maxConnectionSeconds < 60 || input.maxConnectionSeconds > 1_800) issues.push({ path: "$.maxConnectionSeconds", message: "connection limit is out of bounds" });
  for (const key of ["afterCursor", "maxPendingDeltas"] as const) if (!isNonNegativeInteger(input[key]) || input[key] > 100_000) issues.push({ path: `$.${key}`, message: `${key} is out of bounds` });
  const filterFingerprint = requireString(input, "filterFingerprint", issues);
  if (filterFingerprint !== undefined) checkSafeToken(filterFingerprint, "$.filterFingerprint", issues, 128);
  if (!filterFingerprint) return { ok: false, issues };
  return finishValidation(
    { schemaVersion: "DiagnosticStreamControl/v1", heartbeatIntervalSeconds: input.heartbeatIntervalSeconds as number, maxConnectionSeconds: input.maxConnectionSeconds as number, afterCursor: input.afterCursor as number, filterFingerprint, maxPendingDeltas: input.maxPendingDeltas as number },
    issues,
  );
};
export const parseStreamControl = (input: unknown): DiagnosticStreamControlV1 => parseOrThrow(validateStreamControl(input), "Invalid stream control");

export const validateStreamClose = (input: unknown): ValidationResult<DiagnosticStreamCloseV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected stream close" }] };
  if (input.schemaVersion !== "DiagnosticStreamClose/v1") issues.push({ path: "$.schemaVersion", message: "expected DiagnosticStreamClose/v1" });
  if (!checkEnum(input.reason, ["slow_consumer", "expired", "unauthorized", "server_shutdown", "filter_mismatch", "client_disconnected", "deadline", "server_error"] as const, "$.reason", issues)) return { ok: false, issues };
  if (!isNonNegativeInteger(input.resumableCursor) || typeof input.refillRequired !== "boolean") issues.push({ path: "$", message: "resumableCursor/refillRequired are invalid" });
  if (!isNonNegativeInteger(input.resumableCursor) || typeof input.refillRequired !== "boolean") return { ok: false, issues };
  return finishValidation({ schemaVersion: "DiagnosticStreamClose/v1", reason: input.reason as DiagnosticStreamCloseV1["reason"], resumableCursor: input.resumableCursor, refillRequired: input.refillRequired }, issues);
};
export const parseStreamClose = (input: unknown): DiagnosticStreamCloseV1 => parseOrThrow(validateStreamClose(input), "Invalid stream close");

export const validateStreamStatus = (input: unknown): ValidationResult<DiagnosticStreamStatusV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected stream status" }] };
  if (input.schemaVersion !== "DiagnosticStreamStatus/v1") issues.push({ path: "$.schemaVersion", message: "expected DiagnosticStreamStatus/v1" });
  if (typeof input.connected !== "boolean" || !isNonNegativeInteger(input.lastCursor) || !isNonNegativeInteger(input.committedCursor) || !isNonNegativeInteger(input.projectedCursor) || !isNonNegativeInteger(input.projectorLagMilliseconds) || typeof input.gapRefillRequired !== "boolean")
    issues.push({ path: "$", message: "stream status fields are invalid" });
  if (typeof input.connected !== "boolean" || !isNonNegativeInteger(input.lastCursor) || !isNonNegativeInteger(input.committedCursor) || !isNonNegativeInteger(input.projectedCursor) || !isNonNegativeInteger(input.projectorLagMilliseconds) || typeof input.gapRefillRequired !== "boolean")
    return { ok: false, issues };
  return finishValidation(
    { schemaVersion: "DiagnosticStreamStatus/v1", connected: input.connected, lastCursor: input.lastCursor, committedCursor: input.committedCursor, projectedCursor: input.projectedCursor, projectorLagMilliseconds: input.projectorLagMilliseconds, gapRefillRequired: input.gapRefillRequired },
    issues,
  );
};
export const parseStreamStatus = (input: unknown): DiagnosticStreamStatusV1 => parseOrThrow(validateStreamStatus(input), "Invalid stream status");
