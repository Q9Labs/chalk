import { ENVIRONMENTS, UNKNOWN_REASONS, isEnvironment } from "./allowlists.js";
import { parseDiagnosticReference, validateDiagnosticReferenceField } from "./references.js";
import { checkDateTime, checkEnum, checkSafeToken, finishValidation, isBoolean, isFiniteNumber, isNonNegativeInteger, isRecord, isString, parseOrThrow, pushUnknownKeys, requireString, type ValidationIssue, type ValidationResult } from "./runtime.js";
import { validateDiagnosticBranch, validateDiagnosticIssue, validateDiagnosticOperation } from "./details.js";
import type { AgentBriefGap, AgentBriefV1, DiagnosticBranchDetail, DiagnosticExportJob, DiagnosticExportManifestV1, DiagnosticIssueDetail, DiagnosticOperationDetail, ExportJobState } from "./types.js";

const BRIEF_KEYS = [
  "schemaVersion",
  "version",
  "reference",
  "focusedReference",
  "captureTime",
  "selectedCursor",
  "runEndCursor",
  "observedSummary",
  "environment",
  "resolverCommand",
  "releaseCommits",
  "visibleGaps",
  "episodeSummary",
  "issues",
  "operations",
  "branches",
  "counts",
  "omissions",
] as const;
const JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled", "expired"] as const satisfies readonly ExportJobState[];

const parseBoundedStrings = (input: unknown, path: string, issues: ValidationIssue[], maxLength = 256): string[] => {
  if (!Array.isArray(input) || input.some((value) => !isString(value) || value.length > maxLength)) {
    issues.push({ path, message: "expected a bounded string array" });
    return [];
  }
  return input as string[];
};

const validateGapCursors = (input: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  for (const key of ["firstCursor", "lastCursor"] as const) {
    if (input[key] !== undefined && !isNonNegativeInteger(input[key])) issues.push({ path: `${path}.${key}`, message: `${key} must be non-negative` });
  }
};

const validateGapReason = (reason: string | undefined, path: string, issues: ValidationIssue[]): void => {
  if (reason === undefined || UNKNOWN_REASONS.includes(reason as (typeof UNKNOWN_REASONS)[number]) || /^[a-z][a-z0-9_.-]{0,63}$/.test(reason)) return;
  issues.push({ path: `${path}.reason`, message: "gap reason is not safe" });
};

const parseGap = (input: unknown, path: string, issues: ValidationIssue[]): AgentBriefGap | undefined => {
  if (!isRecord(input)) {
    issues.push({ path, message: "expected a brief gap object" });
    return undefined;
  }
  const kind = requireString(input, "kind", issues, path);
  const summary = requireString(input, "summary", issues, path);
  const reason = requireString(input, "reason", issues, path);
  validateGapReason(reason, path, issues);
  validateGapCursors(input, path, issues);
  if (!kind || !summary || !reason) return undefined;
  return { kind, summary, reason, ...(input.firstCursor === undefined ? {} : { firstCursor: input.firstCursor as number }), ...(input.lastCursor === undefined ? {} : { lastCursor: input.lastCursor as number }) };
};

const validateFocusedReference = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  if (input.focusedReference === undefined) return;
  if (!isString(input.focusedReference)) {
    issues.push({ path: "$.focusedReference", message: "focusedReference must be a string" });
    return;
  }
  try {
    parseDiagnosticReference(input.focusedReference);
  } catch {
    issues.push({ path: "$.focusedReference", message: "focusedReference is malformed" });
  }
};

const validateBriefCursors = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  for (const key of ["selectedCursor", "runEndCursor"] as const) {
    if (input[key] !== undefined && !isNonNegativeInteger(input[key])) issues.push({ path: `$.${key}`, message: `${key} must be non-negative` });
  }
};

const validateBriefHeader = (input: Record<string, unknown>, issues: ValidationIssue[]): boolean => {
  if (input.schemaVersion !== "AgentBrief/v1") issues.push({ path: "$.schemaVersion", message: "expected AgentBrief/v1" });
  if (input.version !== 1) issues.push({ path: "$.version", message: "only AgentBrief version 1 is supported" });
  validateDiagnosticReferenceField(input, "reference", issues);
  validateFocusedReference(input, issues);
  checkDateTime(input.captureTime, "$.captureTime", issues);
  validateBriefCursors(input, issues);
  const observedSummary = requireString(input, "observedSummary", issues);
  if (observedSummary !== undefined && observedSummary.length > 512) issues.push({ path: "$.observedSummary", message: "observedSummary is too long" });
  if (!checkEnum(input.environment, ENVIRONMENTS, "$.environment", issues)) return false;
  const resolverCommand = requireString(input, "resolverCommand", issues);
  if (resolverCommand !== undefined && (resolverCommand.length > 512 || !resolverCommand.startsWith("pnpm trace:inspect "))) issues.push({ path: "$.resolverCommand", message: "resolverCommand must be the canonical CLI command" });
  return true;
};

const validateReleaseSourceCommit = (release: Record<string, unknown>, path: string, issues: ValidationIssue[]): void => {
  if (release.sourceCommit !== undefined && (!isString(release.sourceCommit) || release.sourceCommit.length > 160)) issues.push({ path: `${path}.sourceCommit`, message: "sourceCommit is too long" });
};

const validateReleaseUnknownReason = (release: Record<string, unknown>, path: string, issues: ValidationIssue[]): boolean => release.unknownReason === undefined || checkEnum(release.unknownReason, UNKNOWN_REASONS, `${path}.unknownReason`, issues);

const parseReleaseCommit = (release: unknown, index: number, issues: ValidationIssue[]): AgentBriefV1["releaseCommits"][number] | undefined => {
  const path = `$.releaseCommits[${index}]`;
  if (!isRecord(release)) {
    issues.push({ path, message: "expected release mapping" });
    return undefined;
  }
  const releaseId = requireString(release, "release", issues, path);
  if (releaseId !== undefined) checkSafeToken(releaseId, `${path}.release`, issues, 160);
  validateReleaseSourceCommit(release, path, issues);
  if (!validateReleaseUnknownReason(release, path, issues)) return undefined;
  if (!releaseId) return undefined;
  return { release: releaseId, ...(release.sourceCommit === undefined ? {} : { sourceCommit: release.sourceCommit as string }), ...(release.unknownReason === undefined ? {} : { unknownReason: release.unknownReason as AgentBriefV1["releaseCommits"][number]["unknownReason"] }) };
};

const parseReleaseCommits = (input: unknown, issues: ValidationIssue[]): Array<AgentBriefV1["releaseCommits"][number]> => {
  if (!Array.isArray(input)) {
    issues.push({ path: "$.releaseCommits", message: "releaseCommits must be an array" });
    return [];
  }
  const releaseCommits: Array<AgentBriefV1["releaseCommits"][number]> = [];
  for (const [index, release] of input.entries()) {
    const parsed = parseReleaseCommit(release, index, issues);
    if (parsed) releaseCommits.push(parsed);
  }
  return releaseCommits;
};

const parseVisibleGaps = (input: unknown, issues: ValidationIssue[]): AgentBriefGap[] => {
  if (!Array.isArray(input)) {
    issues.push({ path: "$.visibleGaps", message: "visibleGaps must be an array" });
    return [];
  }
  const visibleGaps: AgentBriefGap[] = [];
  for (const [index, gap] of input.entries()) {
    const parsed = parseGap(gap, `$.visibleGaps[${index}]`, issues);
    if (parsed) visibleGaps.push(parsed);
  }
  return visibleGaps;
};

const parseBriefDetails = <T>(input: Record<string, unknown>, key: "issues" | "operations" | "branches", parser: (value: unknown) => ValidationResult<T>, issues: ValidationIssue[]): T[] | undefined => {
  const source = input[key];
  if (source === undefined) return undefined;
  if (!Array.isArray(source)) {
    issues.push({ path: `$.${key}`, message: `${key} must be an array` });
    return undefined;
  }
  const output: T[] = [];
  for (const [index, value] of source.entries()) {
    const result = parser(value);
    if (result.ok) output.push(result.value);
    else issues.push(...result.issues.map((item) => ({ ...item, path: `$.${key}[${index}]${item.path === "$" ? "" : item.path.slice(1)}` })));
  }
  return output;
};

const parseBriefCounts = (input: unknown, issues: ValidationIssue[]): Record<string, number> => {
  if (!isRecord(input)) {
    issues.push({ path: "$.counts", message: "counts must be an object" });
    return {};
  }
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[a-z][A-Za-z0-9_]{0,63}$/.test(key) || !isNonNegativeInteger(value)) issues.push({ path: `$.counts.${key}`, message: "count key/value is unsafe" });
    else counts[key] = value;
  }
  return counts;
};

const validateBriefOptionalText = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  if (input.episodeSummary !== undefined && (!isString(input.episodeSummary) || input.episodeSummary.length > 512)) issues.push({ path: "$.episodeSummary", message: "episodeSummary is too long" });
};

export const validateAgentBrief = (input: unknown): ValidationResult<AgentBriefV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected AgentBrief object" }] };
  pushUnknownKeys(input, BRIEF_KEYS, issues, "$");
  if (!validateBriefHeader(input, issues)) return { ok: false, issues };
  const reference = input.reference as string | undefined;
  const captureTime = input.captureTime as string | undefined;
  const observedSummary = input.observedSummary as string | undefined;
  const resolverCommand = input.resolverCommand as string | undefined;
  const releaseCommits = parseReleaseCommits(input.releaseCommits, issues);
  const visibleGaps = parseVisibleGaps(input.visibleGaps, issues);
  validateBriefOptionalText(input, issues);
  const parsedIssues = parseBriefDetails(input, "issues", validateDiagnosticIssue, issues);
  const operations = parseBriefDetails(input, "operations", validateDiagnosticOperation, issues);
  const branches = parseBriefDetails(input, "branches", validateDiagnosticBranch, issues);
  const counts = parseBriefCounts(input.counts, issues);
  const omissions = parseBoundedStrings(input.omissions, "$.omissions", issues, 160);
  if (!reference || !captureTime || !observedSummary || !resolverCommand || !isEnvironment(input.environment) || !Array.isArray(input.releaseCommits) || !Array.isArray(input.visibleGaps)) return { ok: false, issues };
  return finishValidation(
    {
      schemaVersion: "AgentBrief/v1",
      version: 1,
      reference,
      ...(input.focusedReference === undefined ? {} : { focusedReference: input.focusedReference as string }),
      captureTime: captureTime as string,
      ...(input.selectedCursor === undefined ? {} : { selectedCursor: input.selectedCursor as number }),
      ...(input.runEndCursor === undefined ? {} : { runEndCursor: input.runEndCursor as number }),
      observedSummary,
      environment: input.environment,
      resolverCommand,
      releaseCommits,
      visibleGaps,
      ...(input.episodeSummary === undefined ? {} : { episodeSummary: input.episodeSummary as string }),
      ...(parsedIssues === undefined ? {} : { issues: parsedIssues as DiagnosticIssueDetail[] }),
      ...(operations === undefined ? {} : { operations: operations as DiagnosticOperationDetail[] }),
      ...(branches === undefined ? {} : { branches: branches as DiagnosticBranchDetail[] }),
      counts,
      omissions,
    },
    issues,
  );
};

export const parseAgentBrief = (input: unknown): AgentBriefV1 => parseOrThrow(validateAgentBrief(input), "Invalid AgentBrief/v1");
export const parseAgentBriefV1 = parseAgentBrief;
export const validateAgentBriefV1 = validateAgentBrief;

export const renderAgentBriefMarkdown = (briefInput: AgentBriefV1): string => {
  const brief = parseAgentBrief(briefInput);
  const lines = [
    "# Chalk Diagnostic Brief",
    "",
    `- Schema: ${brief.schemaVersion}`,
    `- Reference: ${brief.reference}`,
    ...(brief.focusedReference ? [`- Focus: ${brief.focusedReference}`] : []),
    `- Environment: ${brief.environment}`,
    `- Captured: ${brief.captureTime}`,
    ...(brief.selectedCursor === undefined ? [] : [`- Cursor: ${brief.selectedCursor}`]),
    ...(brief.runEndCursor === undefined ? [] : [`- Run end cursor: ${brief.runEndCursor}`]),
    "",
    `Observed: ${brief.observedSummary}`,
    "",
    "## Release",
    ...brief.releaseCommits.map((entry) => `- ${entry.release}: ${entry.sourceCommit ?? `unknown (${entry.unknownReason ?? "not_available"})`}`),
    "",
    "## Gaps",
    ...(brief.visibleGaps.length === 0 ? ["- None observed"] : brief.visibleGaps.map((gap) => `- ${gap.kind}: ${gap.summary} (${gap.reason})`)),
    "",
    "## Counts",
    ...Object.entries(brief.counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Omissions",
    ...(brief.omissions.length === 0 ? ["- None"] : brief.omissions.map((omission) => `- ${omission}`)),
    "",
    `Resolver: \`${brief.resolverCommand}\``,
  ];
  return lines.join("\n");
};

export const buildAgentBriefMarkdown = renderAgentBriefMarkdown;

const MANIFEST_KEYS = ["schemaVersion", "reference", "cursorFrom", "cursorTo", "eventCount", "omissionCount", "checksums", "compressed", "splitParts"] as const;

const validateManifestCursors = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  for (const key of ["cursorFrom", "cursorTo", "eventCount", "omissionCount", "splitParts"] as const) {
    if (input[key] !== undefined && !isNonNegativeInteger(input[key])) issues.push({ path: `$.${key}`, message: `${key} must be non-negative` });
  }
};

const validateManifestChecksums = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  if (!isRecord(input.checksums)) {
    issues.push({ path: "$.checksums", message: "checksums must be bounded safe strings" });
    return;
  }
  if (Object.entries(input.checksums).some(([key, value]) => !/^[A-Za-z0-9_.-]{1,128}$/.test(key) || !isString(value) || value.length > 256)) issues.push({ path: "$.checksums", message: "checksums must be bounded safe strings" });
};

export const validateDiagnosticExportManifest = (input: unknown): ValidationResult<DiagnosticExportManifestV1> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected export manifest" }] };
  pushUnknownKeys(input, MANIFEST_KEYS, issues, "$");
  if (input.schemaVersion !== "DiagnosticBundle/v1") issues.push({ path: "$.schemaVersion", message: "expected DiagnosticBundle/v1" });
  const reference = validateDiagnosticReferenceField(input, "reference", issues);
  validateManifestCursors(input, issues);
  validateManifestChecksums(input, issues);
  if (!isBoolean(input.compressed)) issues.push({ path: "$.compressed", message: "compressed must be boolean" });
  if (!reference || !isNonNegativeInteger(input.cursorFrom) || !isNonNegativeInteger(input.cursorTo) || !isNonNegativeInteger(input.eventCount) || !isNonNegativeInteger(input.omissionCount) || !isBoolean(input.compressed) || !isRecord(input.checksums)) return { ok: false, issues };
  return finishValidation(
    {
      schemaVersion: "DiagnosticBundle/v1",
      reference,
      cursorFrom: input.cursorFrom,
      cursorTo: input.cursorTo,
      eventCount: input.eventCount,
      omissionCount: input.omissionCount,
      checksums: input.checksums as Record<string, string>,
      compressed: input.compressed,
      ...(input.splitParts === undefined ? {} : { splitParts: input.splitParts as number }),
    },
    issues,
  );
};

export const parseDiagnosticExportManifest = (input: unknown): DiagnosticExportManifestV1 => parseOrThrow(validateDiagnosticExportManifest(input), "Invalid diagnostic export manifest");

const JOB_KEYS = ["schemaVersion", "jobId", "reference", "state", "createdAt", "leaseEndsAt", "downloadExpiresAt", "cursorFrom", "cursorTo", "manifest", "errorReason", "progress", "cancelledAt", "downloadUrl"] as const;
export type ExportJobProgress = Readonly<{ processedEvents: number; totalEvents?: number; percent?: number; currentCursor?: number }>;
export type DiagnosticExportStatus = DiagnosticExportJob & Readonly<{ progress?: ExportJobProgress; cancelledAt?: string; downloadUrl?: string }>;

type ExportJobHeader = Readonly<{ jobId?: string; reference?: string; stateValid: boolean }>;

const validateExportJobHeader = (input: Record<string, unknown>, issues: ValidationIssue[]): ExportJobHeader => {
  if (input.schemaVersion !== "ExportJob/v1") issues.push({ path: "$.schemaVersion", message: "expected ExportJob/v1" });
  const jobId = requireString(input, "jobId", issues);
  if (jobId !== undefined) checkSafeToken(jobId, "$.jobId", issues, 128);
  const reference = validateDiagnosticReferenceField(input, "reference", issues);
  return { jobId, reference, stateValid: checkEnum(input.state, JOB_STATES, "$.state", issues) };
};

const validateExportJobBounds = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  for (const key of ["createdAt", "leaseEndsAt", "downloadExpiresAt", "cancelledAt"] as const) {
    if (input[key] !== undefined) checkDateTime(input[key], `$.${key}`, issues);
  }
  for (const key of ["cursorFrom", "cursorTo"] as const) {
    if (input[key] !== undefined && !isNonNegativeInteger(input[key])) issues.push({ path: `$.${key}`, message: `${key} must be non-negative` });
  }
};

const validateExportProgressBounds = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  for (const key of ["processedEvents", "totalEvents", "currentCursor"] as const) {
    if (input[key] !== undefined && !isNonNegativeInteger(input[key])) issues.push({ path: `$.progress.${key}`, message: `${key} must be non-negative` });
  }
  const percent = input.percent;
  if (percent !== undefined && (!isFiniteNumber(percent) || percent < 0 || percent > 100)) issues.push({ path: "$.progress.percent", message: "percent must be between 0 and 100" });
};

const buildExportJobProgress = (input: Record<string, unknown>, percent: unknown): ExportJobProgress => ({
  processedEvents: input.processedEvents as number,
  ...(input.totalEvents === undefined ? {} : { totalEvents: input.totalEvents as number }),
  ...(percent === undefined ? {} : { percent: percent as number }),
  ...(input.currentCursor === undefined ? {} : { currentCursor: input.currentCursor as number }),
});

const parseExportJobProgress = (input: unknown, issues: ValidationIssue[]): ExportJobProgress | undefined => {
  if (input === undefined) return undefined;
  if (!isRecord(input)) {
    issues.push({ path: "$.progress", message: "progress must be an object" });
    return undefined;
  }
  validateExportProgressBounds(input, issues);
  const percent = input.percent;
  if (!isNonNegativeInteger(input.processedEvents)) {
    issues.push({ path: "$.progress.processedEvents", message: "processedEvents is required" });
    return undefined;
  }
  return buildExportJobProgress(input, percent);
};

const validateExportJobErrorReason = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  if (input.errorReason !== undefined && (!isString(input.errorReason) || input.errorReason.length > 160)) issues.push({ path: "$.errorReason", message: "errorReason is too long" });
};

const validateExportJobDownloadUrl = (input: Record<string, unknown>, issues: ValidationIssue[]): void => {
  if (input.downloadUrl !== undefined && (!isString(input.downloadUrl) || input.downloadUrl.length > 512 || !input.downloadUrl.startsWith("/_internal/"))) issues.push({ path: "$.downloadUrl", message: "downloadUrl must be an internal bounded path" });
};

export const validateDiagnosticExportJob = (input: unknown): ValidationResult<DiagnosticExportStatus> => {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected export job" }] };
  pushUnknownKeys(input, JOB_KEYS, issues, "$");
  const header = validateExportJobHeader(input, issues);
  if (!header.stateValid) return { ok: false, issues };
  const { jobId, reference } = header;
  validateExportJobBounds(input, issues);
  const manifest = input.manifest === undefined ? undefined : validateDiagnosticExportManifest(input.manifest);
  if (manifest && !manifest.ok) issues.push(...manifest.issues);
  validateExportJobErrorReason(input, issues);
  const progress = parseExportJobProgress(input.progress, issues);
  validateExportJobDownloadUrl(input, issues);
  if (!jobId || !reference || !isString(input.createdAt) || !isString(input.leaseEndsAt)) return { ok: false, issues };
  return finishValidation(
    {
      schemaVersion: "ExportJob/v1",
      jobId,
      reference,
      state: input.state as ExportJobState,
      createdAt: input.createdAt,
      leaseEndsAt: input.leaseEndsAt,
      ...(input.downloadExpiresAt === undefined ? {} : { downloadExpiresAt: input.downloadExpiresAt as string }),
      cursorFrom: input.cursorFrom as number,
      ...(input.cursorTo === undefined ? {} : { cursorTo: input.cursorTo as number }),
      ...(manifest && manifest.ok ? { manifest: manifest.value } : {}),
      ...(input.errorReason === undefined ? {} : { errorReason: input.errorReason as string }),
      ...(progress === undefined ? {} : { progress }),
      ...(input.cancelledAt === undefined ? {} : { cancelledAt: input.cancelledAt as string }),
      ...(input.downloadUrl === undefined ? {} : { downloadUrl: input.downloadUrl as string }),
    },
    issues,
  );
};

export const parseDiagnosticExportJob = (input: unknown): DiagnosticExportStatus => parseOrThrow(validateDiagnosticExportJob(input), "Invalid ExportJob/v1");
export const parseExportJob = parseDiagnosticExportJob;
