import type { ScreenAnnotationLayer, ScreenAnnotationMark } from "@q9labsai/chalk-client";
import { MAXIMUM_RECORDING_DURATION_MS } from "../generated/render-contract.js";
import { exactKeys, field, objectValue, stringField } from "../validation.js";
import { parseMark } from "./annotation-mark.js";
import { LABEL, record, list, literal, integer, uuid, booleanField, invalid } from "./annotation-archive-fields.js";

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
const SOURCE_ID = /^rps_[0-9a-f]{64}$/;

export function parseRecordingAnnotation(value: unknown, binding: AnnotationRecordingBinding): readonly BoundAnnotationLayer[] {
  const root = record(value, ["version", "recordingId", "episodeId", "originAuthorityId", "captureEpoch", "layers"]);
  literal(root, "version", 1);
  literal(root, "recordingId", binding.recordingId);
  literal(root, "episodeId", binding.episodeId);
  literal(root, "originAuthorityId", binding.originAuthorityId);
  literal(root, "captureEpoch", binding.captureEpoch);
  const layers = list(field(root, "layers"), 4096).map((item) => parseBoundLayer(item, binding));
  layers.sort((left, right) => left.initial.atMs - right.initial.atMs);
  validateLayerBindings(layers);
  return layers;
}

function validateLayerBindings(layers: readonly BoundAnnotationLayer[]): void {
  const ids = new Set<string>();
  const endOfSource = new Map<string, number>();
  for (const layer of layers) {
    const id = layer.layer.layer_id;
    for (const source of layer.sourceIds) {
      validateSourceBinding(layer, id, source, ids, endOfSource);
    }
  }
}

function validateSourceBinding(layer: BoundAnnotationLayer, id: string, source: string, ids: Set<string>, endOfSource: Map<string, number>): void {
  // A capture retry can checkpoint the same live layer against a new source ID.
  const binding = `${id}:${source}`;
  if (ids.has(binding)) throw invalid("has a duplicate layer binding");
  ids.add(binding);
  if ((endOfSource.get(source) ?? 0) > layer.initial.atMs) throw invalid("has overlapping source bindings");
  endOfSource.set(source, layer.closedAtMs);
}

function parseBoundLayer(value: unknown, binding: AnnotationRecordingBinding): BoundAnnotationLayer {
  const entry = record(value, ["sourceIds", "sidecar"]);
  const sidecar = parseSidecar(field(entry, "sidecar"));
  const sourceIds = list(field(entry, "sourceIds"), 4096).map((id) => boundSourceId(id, sidecar.layer.sharer_id, binding.sources));
  if (!sourceIds.length || new Set(sourceIds).size !== sourceIds.length) throw invalid("has an invalid set of media source references");
  return { ...sidecar, sourceIds };
}

function boundSourceId(id: unknown, sharerId: string, sources: AnnotationRecordingBinding["sources"]): string {
  if (typeof id !== "string" || !SOURCE_ID.test(id)) throw invalid("has an invalid media source reference");
  if (!belongsToScreenSharer(sources.get(id), sharerId)) throw invalid("does not match the authenticated screen source");
  return id;
}

function belongsToScreenSharer(source: { readonly kind: string; readonly participantId: string } | undefined, sharerId: string): boolean {
  return source?.kind === "screen_share" && source.participantId === sharerId;
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
  validateCheckpoint(initial);
  const changes = parseChanges(field(sidecar, "changes"), initial, closedAtMs);
  return { version: 1, layer, initial, changes, closedAtMs };
}

function validateCheckpoint(initial: AnnotationSidecar["initial"]): void {
  const ids = new Set<string>();
  for (const mark of initial.marks) {
    if (!validCheckpointMark(mark, initial) || ids.has(mark.draft.mark_id)) throw invalid("has an invalid checkpoint mark");
    ids.add(mark.draft.mark_id);
  }
}

function validCheckpointMark(mark: ScreenAnnotationMark, initial: Revision): boolean {
  return mark.committed_at_ms <= initial.atMs && mark.created_revision <= initial.revision;
}
function parseChanges(value: unknown, initial: Revision, closedAtMs: number): AnnotationSidecar["changes"] {
  const revisions = new Map<number, AnnotationSidecar["changes"][number]>();
  for (const itemValue of list(value, 262_144)) {
    const raw = record(itemValue, ["atMs", "revision", "change"]);
    const item = { ...revision(raw), change: parseChange(field(raw, "change")) };
    validateChangeBoundary(item, initial, closedAtMs);
    const duplicate = revisions.get(item.revision);
    if (duplicate !== undefined && JSON.stringify(duplicate) !== JSON.stringify(item)) throw invalid("has conflicting changes at one revision");
    revisions.set(item.revision, item);
  }
  const changes = [...revisions.values()].sort((left, right) => left.revision - right.revision);
  validateChangeOrder(changes, initial.atMs);
  return changes;
}

function validateChangeBoundary(item: Revision, initial: Revision, closedAtMs: number): void {
  if (item.atMs < initial.atMs || item.atMs > closedAtMs || item.revision <= initial.revision) throw invalid("has a change outside its capture boundary");
}

function validateChangeOrder(changes: AnnotationSidecar["changes"], initialTime: number): void {
  let lastTime = initialTime;
  for (const item of changes) {
    if (item.atMs < lastTime) throw invalid("has changes out of capture-clock order");
    if (item.change.kind === "upsert") validateCommittedMark(item.change.mark, item);
    lastTime = item.atMs;
  }
}

function validateCommittedMark(mark: ScreenAnnotationMark, item: Revision): void {
  if (mark.committed_at_ms > item.atMs || mark.created_revision > item.revision) throw invalid("has an invalid committed mark");
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

const changeParsers = new Map<unknown, (change: object) => AnnotationChange>([
  [
    "upsert",
    (change) => {
      exactKeys(change, ["kind", "mark"], LABEL);
      return { kind: "upsert", mark: parseMark(field(change, "mark")) };
    },
  ],
  [
    "remove",
    (change) => {
      exactKeys(change, ["kind", "mark_id"], LABEL);
      return { kind: "remove", mark_id: uuid(change, "mark_id") };
    },
  ],
  [
    "clear",
    (change) => {
      exactKeys(change, ["kind", "participant_id"], LABEL);
      return { kind: "clear", participant_id: field(change, "participant_id") === null ? null : uuid(change, "participant_id") };
    },
  ],
  [
    "control",
    (change) => {
      exactKeys(change, ["kind", "paused"], LABEL);
      return { kind: "control", paused: booleanField(change, "paused") };
    },
  ],
]);

function parseChange(value: unknown): AnnotationChange {
  const change = objectValue(value, LABEL);
  const parse = changeParsers.get(field(change, "kind"));
  if (!parse) throw invalid("has an invalid change kind");
  return parse(change);
}

function revision(value: object): Revision {
  return { atMs: integer(value, "atMs", 0, MAXIMUM_RECORDING_DURATION_MS), revision: integer(value, "revision", 1) };
}
