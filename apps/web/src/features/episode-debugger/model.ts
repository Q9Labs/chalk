import type { AcceptedDiagnosticEvent, DiagnosticBranchDetail, DiagnosticIssueDetail, DiagnosticOperationDetail, ParticipantProjectionV1 } from "@chalk/diagnostics-contracts";

export const DEBUGGER_VIEWS = ["run", "graph", "trace", "flame", "issues", "participants", "epilogue"] as const;
export type DebuggerView = (typeof DEBUGGER_VIEWS)[number];

export type DebuggerSelection =
  | Readonly<{ kind: "operation"; value: DiagnosticOperationDetail }>
  | Readonly<{ kind: "issue"; value: DiagnosticIssueDetail }>
  | Readonly<{ kind: "event"; value: AcceptedDiagnosticEvent }>
  | Readonly<{ kind: "branch"; value: DiagnosticBranchDetail }>
  | Readonly<{ kind: "participant"; value: ParticipantProjectionV1 }>
  | Readonly<{ kind: "edge"; value: Readonly<{ id: string; operationIds: readonly string[]; issueIds: readonly string[]; state: string }> }>;

export const selectedId = (selection: DebuggerSelection | undefined): string | undefined => (!selection ? undefined : selection.kind === "event" ? String(selection.value.cursor) : selection.kind === "participant" ? selection.value.participantId : selection.value.id);

export const formatDuration = (milliseconds: number | undefined): string => {
  if (milliseconds === undefined) return "unknown: not available";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

export const formatTime = (value: string | undefined): string => {
  if (!value) return "unknown: not available";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown: invalid time";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

export const stateTone = (state: string): "live" | "success" | "warning" | "danger" | "neutral" => {
  if (["live", "running", "active", "retrying", "joined"].includes(state)) return "live";
  if (["succeeded", "healthy", "complete", "observed"].includes(state)) return "success";
  if (["stalled", "pending", "reconnecting", "not_observable", "unobservable"].includes(state)) return "warning";
  if (["failed", "timed_out", "critical", "error"].includes(state)) return "danger";
  return "neutral";
};
