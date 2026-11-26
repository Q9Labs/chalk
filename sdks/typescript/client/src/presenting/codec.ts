import type { components } from "../generated/presenting-v1";

type Wire = components["schemas"];
const serverTypes = new Set(["presenting_state", "presenting_changed", "presenting_receipt"]);

export function encodePresentingFrame(frame: Wire["ClientFrame"]): string {
  const wire = JSON.stringify(frame);
  if (new TextEncoder().encode(wire).byteLength > 4096) throw new Error("presenting frame too large");
  return wire;
}

/** Server frames are small and have closed shapes; the base Sync codec uses this before its own schema. */
export function presentingServerFrame(value: unknown): Wire["ServerFrame"] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (typeof frame.type !== "string" || !serverTypes.has(frame.type)) return null;
  if (frame.type === "presenting_receipt") {
    return typeof frame.operation_id === "string" && isResult(frame.result) ? (frame as Wire["ServerReceipt"]) : null;
  }
  if (!Number.isSafeInteger(frame.server_at_ms)) return null;
  if (frame.type === "presenting_state") {
    if (frame.enabled === false && frame.state === null) return frame as Wire["ServerState"];
    return isState(frame.state) ? (frame as Wire["ServerState"]) : null;
  }
  return isState(frame.state) ? (frame as Wire["ServerChange"]) : null;
}

function isState(value: unknown): value is Wire["State"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Number.isSafeInteger(state.revision) && Array.isArray(state.documents) && state.documents.every(isDocument);
}

function isDocument(value: unknown): value is Wire["Document"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  return typeof document.document_id === "string" && typeof document.presenter_id === "string" && Number.isSafeInteger(document.page) && Number.isSafeInteger(document.zoom) && Number.isSafeInteger(document.started_at_ms);
}

function isResult(value: unknown): value is Wire["CommandResult"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (result.kind === "accepted" && Number.isSafeInteger(result.revision)) || (result.kind === "rejected" && typeof result.reason === "string");
}
