import type { ConnectionSnapshot } from "./types";

export type ConferencePhase = "prejoin" | "joining" | "waiting" | "active" | "reconnecting" | "ended";

export type ConferencePhaseInput = {
  readonly snapshot: Pick<ConnectionSnapshot, "state" | "failure" | "connection">;
  readonly hasAskedToJoin: boolean;
  readonly hasAskedToLeave: boolean;
};

export function deriveConferencePhase(input: ConferencePhaseInput): ConferencePhase {
  if (input.hasAskedToLeave || input.snapshot.failure?.code === "session_ended") return "ended";

  switch (input.snapshot.state) {
    case "idle":
      return input.hasAskedToJoin ? "joining" : "prejoin";
    case "joining":
      return "joining";
    case "live":
      return isRecovering(input.snapshot.connection) ? "reconnecting" : "active";
    case "reconnecting":
      return "reconnecting";
    case "leaving":
    case "left":
    case "failed":
      return "ended";
  }
}

function isRecovering(connection: ConnectionSnapshot["connection"]): boolean {
  return connection.sync === "recovering" || connection.media === "recovering";
}
