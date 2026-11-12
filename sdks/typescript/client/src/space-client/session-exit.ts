import type { ConnectionSlice } from "./types";

/** Why a joined call is over for this participant, apart from their own Leave. */
export type SessionExit = "episode-ended" | "removed" | "failed";

export function sessionExit(connection: ConnectionSlice): SessionExit | undefined {
  if (connection.episodeEnded) return "episode-ended";
  if (connection.removedByHost) return "removed";
  if (connection.status !== "failed") return undefined;
  return connection.lastError?.code === "episode.ended" ? "episode-ended" : "failed";
}
