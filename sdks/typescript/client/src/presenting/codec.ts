import type { components } from "../generated/presenting-v1";

type Wire = components["schemas"];
type Record_ = Record<string, unknown>;
const serverTypes = new Set(["presenting_state", "presenting_changed", "presenting_receipt"]);

export function encodePresentingFrame(frame: Wire["ClientFrame"]): string {
  const wire = JSON.stringify(frame);
  if (new TextEncoder().encode(wire).byteLength > 4096) throw new Error("presenting frame too large");
  return wire;
}

/** Server frames are small and have closed shapes; the base Sync codec uses this before its own schema. */
export function presentingServerFrame(value: unknown): Wire["ServerFrame"] | null {
  const frame = record(value);
  if (!frame || typeof frame.type !== "string" || !serverTypes.has(frame.type)) return null;
  if (frame.type === "presenting_receipt") return isReceipt(frame) ? (frame as Wire["ServerReceipt"]) : null;
  if (!Number.isSafeInteger(frame.server_at_ms)) return null;
  if (frame.type === "presenting_state") return isStateFrame(frame) ? (frame as Wire["ServerState"]) : null;
  return isState(frame.state) ? (frame as Wire["ServerChange"]) : null;
}

function record(value: unknown): Record_ | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record_) : null;
}

function isReceipt(frame: Record_): boolean {
  return typeof frame.operation_id === "string" && isResult(frame.result);
}

function isStateFrame(frame: Record_): boolean {
  return (frame.enabled === false && frame.state === null) || isState(frame.state);
}

function isState(value: unknown): value is Wire["State"] {
  const state = record(value);
  return state !== null && Number.isSafeInteger(state.revision) && Array.isArray(state.documents) && state.documents.every(isDocument);
}

function isDocument(value: unknown): value is Wire["Document"] {
  const document = record(value);
  return document !== null && typeof document.document_id === "string" && typeof document.presenter_id === "string" && Number.isSafeInteger(document.page) && Number.isSafeInteger(document.zoom) && Number.isSafeInteger(document.started_at_ms);
}

function isResult(value: unknown): value is Wire["CommandResult"] {
  const result = record(value);
  return result !== null && ((result.kind === "accepted" && Number.isSafeInteger(result.revision)) || (result.kind === "rejected" && typeof result.reason === "string"));
}
