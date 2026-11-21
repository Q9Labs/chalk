import type { ScreenAnnotationLayer, ScreenAnnotationMark, ScreenAnnotationPoint, ScreenAnnotationShape } from "@q9labsai/chalk-client";
import { MAXIMUM_RECORDING_DURATION_MS } from "../generated/render-contract.js";
import { exactKeys, field, integerField, literalField, objectValue, patternedStringField, stringField } from "../validation.js";

type AnnotationChange = { readonly kind: "upsert"; readonly mark: ScreenAnnotationMark } | { readonly kind: "remove"; readonly mark_id: string } | { readonly kind: "clear"; readonly participant_id: string | null } | { readonly kind: "control"; readonly paused: boolean };

interface Revision {
  readonly atMs: number;
  readonly revision: number;
}

interface AnnotationSidecar {
  readonly version: 1;
  readonly layer: ScreenAnnotationLayer;
  readonly initial: Revision & { readonly paused: boolean; readonly marks: readonly ScreenAnnotationMark[] };
  readonly changes: readonly (Revision & { readonly change: AnnotationChange })[];
  readonly closedAtMs: number;
}

/** Bound by the frozen recording artifact, not inferred from a sharer or track name. */
export interface BoundAnnotationLayer extends AnnotationSidecar {
  readonly sourceIds: readonly string[];
}

export interface AnnotationRecordingBinding {
  readonly recordingId: string;
  readonly episodeId: string;
  readonly originAuthorityId: string;
  readonly captureEpoch: number;
  readonly sources: ReadonlyMap<string, { readonly kind: string; readonly participantId: string }>;
}

// Freeze the v1 archive limits independently of future Sync negotiation.
export const ACTIVE_MARKS_V1 = 512;
const COMMITTED_FADE_TTL_MS_V1 = 2_000;
const MAX_MARK_POINTS = 384;
const MAX_MARK_TEXT_BYTES = 512;
const LABEL = "recording annotation sidecar";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^rps_[0-9a-f]{64}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const MAXIMUM_TIME = Number.MAX_SAFE_INTEGER;

export function parseRecordingAnnotation(value: unknown, binding: AnnotationRecordingBinding): readonly BoundAnnotationLayer[] {
  const root = record(value, ["version", "recordingId", "episodeId", "originAuthorityId", "captureEpoch", "layers"]);
  literal(root, "version", 1);
  literal(root, "recordingId", binding.recordingId);
  literal(root, "episodeId", binding.episodeId);
  literal(root, "originAuthorityId", binding.originAuthorityId);
  literal(root, "captureEpoch", binding.captureEpoch);
  const ids = new Set<string>();
  const endOfSource = new Map<string, number>();
  const layers = list(field(root, "layers"), 4096).map((item) => parseBoundLayer(item, binding));
  layers.sort((left, right) => left.initial.atMs - right.initial.atMs);
  for (const layer of layers) {
    const id = layer.layer.layer_id;
    if (ids.has(id)) throw invalid("has a duplicate layer binding");
    ids.add(id);
    for (const source of layer.sourceIds) {
      if ((endOfSource.get(source) ?? 0) > layer.initial.atMs) throw invalid("has overlapping source bindings");
      endOfSource.set(source, layer.closedAtMs);
    }
  }
  return layers;
}

function parseBoundLayer(value: unknown, binding: AnnotationRecordingBinding): BoundAnnotationLayer {
  const entry = record(value, ["sourceIds", "sidecar"]);
  const sidecar = parseSidecar(field(entry, "sidecar"));
  const sourceIds = list(field(entry, "sourceIds"), 4096).map((id) => {
    if (typeof id !== "string" || !SOURCE_ID.test(id)) throw invalid("has an invalid media source reference");
    const source = binding.sources.get(id);
    if (source?.kind !== "screen_share" || source.participantId !== sidecar.layer.sharer_id) throw invalid("does not match the authenticated screen source");
    return id;
  });
  if (sourceIds.length === 0 || new Set(sourceIds).size !== sourceIds.length) throw invalid("has an invalid set of media source references");
  return { ...sidecar, sourceIds };
}

function parseSidecar(value: unknown): AnnotationSidecar {
  const sidecar = record(value, ["version", "layer", "initial", "changes", "closedAtMs"]);
  literal(sidecar, "version", 1);
  const layer = parseLayer(field(sidecar, "layer"));
  const rawInitial = record(field(sidecar, "initial"), ["atMs", "revision", "paused", "marks"]);
  const initial = {
    ...revision(rawInitial),
    paused: booleanField(rawInitial, "paused"),
    marks: list(field(rawInitial, "marks"), ACTIVE_MARKS_V1).map(parseMark),
  };
  const closedAtMs = integer(sidecar, "closedAtMs", initial.atMs, MAXIMUM_RECORDING_DURATION_MS);
  const marks = new Map<string, ScreenAnnotationMark>();
  for (const mark of initial.marks) {
    if (mark.committed_at_ms > initial.atMs || mark.created_revision > initial.revision || marks.has(mark.draft.mark_id)) throw invalid("has an invalid checkpoint mark");
    marks.set(mark.draft.mark_id, mark);
  }

  const revisions = new Map<number, AnnotationSidecar["changes"][number]>();
  for (const value of list(field(sidecar, "changes"), 262_144)) {
    const raw = record(value, ["atMs", "revision", "change"]);
    const item = { ...revision(raw), change: parseChange(field(raw, "change")) };
    if (item.atMs < initial.atMs || item.atMs > closedAtMs || item.revision <= initial.revision) throw invalid("has a change outside its capture boundary");
    const duplicate = revisions.get(item.revision);
    if (duplicate !== undefined && JSON.stringify(duplicate) !== JSON.stringify(item)) throw invalid("has conflicting changes at one revision");
    revisions.set(item.revision, item);
  }
  const changes = [...revisions.values()].sort((left, right) => left.revision - right.revision);
  let lastTime = initial.atMs;
  for (const item of changes) {
    if (item.atMs < lastTime) throw invalid("has changes out of capture-clock order");
    if (item.change.kind === "upsert" && (item.change.mark.committed_at_ms > item.atMs || item.change.mark.created_revision > item.revision)) throw invalid("has an invalid committed mark");
    lastTime = item.atMs;
  }
  return { version: 1, layer, initial, changes, closedAtMs };
}

function parseLayer(value: unknown): ScreenAnnotationLayer {
  const layer = record(value, ["layer_id", "publication_id", "sharer_id", "frame"]);
  const frame = record(field(layer, "frame"), ["width", "height"]);
  return {
    layer_id: uuid(layer, "layer_id"),
    publication_id: stringField(layer, "publication_id", LABEL, 256),
    sharer_id: uuid(layer, "sharer_id"),
    frame: { width: integer(frame, "width", 1, 32768), height: integer(frame, "height", 1, 32768) },
  };
}

function parseChange(value: unknown): AnnotationChange {
  const change = objectValue(value, LABEL);
  const kind = field(change, "kind");
  switch (kind) {
    case "upsert":
      exactKeys(change, ["kind", "mark"], LABEL);
      return { kind, mark: parseMark(field(change, "mark")) };
    case "remove":
      exactKeys(change, ["kind", "mark_id"], LABEL);
      return { kind, mark_id: uuid(change, "mark_id") };
    case "clear":
      exactKeys(change, ["kind", "participant_id"], LABEL);
      return { kind, participant_id: field(change, "participant_id") === null ? null : uuid(change, "participant_id") };
    case "control":
      exactKeys(change, ["kind", "paused"], LABEL);
      return { kind, paused: booleanField(change, "paused") };
    default:
      throw invalid("has an invalid change kind");
  }
}

function parseMark(value: unknown): ScreenAnnotationMark {
  const mark = record(value, ["draft", "author", "created_revision", "committed_at_ms", "expires_at_ms"]);
  const draft = record(field(mark, "draft"), ["mark_id", "lifetime", "color", "width", "shape"]);
  const lifetime = field(draft, "lifetime");
  if (lifetime !== "fade" && lifetime !== "keep") throw invalid("has an invalid mark lifetime");
  const committedAtMs = integer(mark, "committed_at_ms", -MAXIMUM_TIME);
  const expiry = field(mark, "expires_at_ms");
  if (lifetime === "fade" ? expiry !== committedAtMs + COMMITTED_FADE_TTL_MS_V1 : expiry !== null) throw invalid("has an invalid mark expiry");
  const author = record(field(mark, "author"), ["participant_id", "display_name", "color"]);
  return {
    draft: { mark_id: uuid(draft, "mark_id"), lifetime, color: color(draft), width: integer(draft, "width", 32, 3277), shape: parseShape(field(draft, "shape")) },
    author: { participant_id: uuid(author, "participant_id"), display_name: stringField(author, "display_name", LABEL, 256), color: color(author) },
    created_revision: integer(mark, "created_revision", 1),
    committed_at_ms: committedAtMs,
    expires_at_ms: lifetime === "fade" ? integer(mark, "expires_at_ms", -MAXIMUM_TIME) : null,
  };
}

function parseShape(value: unknown): ScreenAnnotationShape {
  const shape = objectValue(value, LABEL);
  const kind = field(shape, "kind");
  switch (kind) {
    case "pen":
    case "highlighter": {
      exactKeys(shape, ["kind", "points"], LABEL);
      const points = list(field(shape, "points"), MAX_MARK_POINTS).map(point);
      if (points.length === 0) throw invalid("has an empty stroke");
      return { kind, points };
    }
    case "line":
    case "arrow":
    case "box":
    case "circle":
      exactKeys(shape, ["kind", "from_point", "to_point"], LABEL);
      return { kind, from_point: point(field(shape, "from_point")), to_point: point(field(shape, "to_point")) };
    case "text": {
      exactKeys(shape, ["kind", "at", "text", "note"], LABEL);
      const text = stringField(shape, "text", LABEL, MAX_MARK_TEXT_BYTES);
      if (Buffer.byteLength(text, "utf8") > MAX_MARK_TEXT_BYTES) throw invalid("has oversized mark text");
      return { kind, at: point(field(shape, "at")), note: booleanField(shape, "note"), text };
    }
    case "stamp": {
      exactKeys(shape, ["kind", "at", "stamp"], LABEL);
      const stamp = field(shape, "stamp");
      if (stamp !== "check" && stamp !== "cross" && stamp !== "star" && stamp !== "question" && stamp !== "heart") throw invalid("has an invalid stamp");
      return { kind, at: point(field(shape, "at")), stamp };
    }
    default:
      throw invalid("has an invalid shape kind");
  }
}

function point(value: unknown): ScreenAnnotationPoint {
  const point = record(value, ["x", "y"]);
  return { x: integer(point, "x", 0, 65535), y: integer(point, "y", 0, 65535) };
}

function revision(value: object): Revision {
  return { atMs: integer(value, "atMs", 0, MAXIMUM_RECORDING_DURATION_MS), revision: integer(value, "revision", 1) };
}

function record(value: unknown, keys: readonly string[]): object {
  const result = objectValue(value, LABEL);
  exactKeys(result, keys, LABEL);
  return result;
}

function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid("has an invalid array");
  return value;
}

function booleanField(value: object, key: string): boolean {
  const result = field(value, key);
  if (typeof result !== "boolean") throw invalid("has an invalid boolean");
  return result;
}

function literal(value: object, key: string, expected: string | number): void {
  literalField(value, key, expected, `${LABEL} has a mismatched ${key}`);
}

function integer(value: object, key: string, minimum: number, maximum = MAXIMUM_TIME): number {
  return integerField(value, key, minimum, maximum, LABEL);
}

function uuid(value: object, key: string): string {
  return patternedStringField(value, key, UUID, LABEL, 36);
}

function color(value: object): string {
  return patternedStringField(value, "color", COLOR, LABEL, 7);
}

function invalid(message: string): TypeError {
  return new TypeError(`${LABEL} ${message}`);
}
