import type { ConnectionSlice } from "@q9labsai/chalk-client";
import type { CallOutcome } from "./StatusPage";

/** What covers the call: nothing, a limbo card over the veiled call, or a status page. */
export type CallScreen = { readonly kind: "call" } | { readonly kind: "joining" } | { readonly kind: "reconnecting" } | { readonly kind: "status"; readonly outcome: CallOutcome };

/**
 * Reads the screen from the connection. `leftByChoice` is true from the moment the person presses
 * Leave or End until they join again, so a leave whose call failed still reads as their choice.
 * Only the server's own removal signal shows "removed"; any other exit nobody chose is `exited`.
 */
export function callScreen(connection: ConnectionSlice, leftByChoice: boolean): CallScreen {
  if (connection.episodeEnded || connection.lastError?.code === "episode.ended") return { kind: "status", outcome: "ended" };
  switch (connection.status) {
    case "idle":
    case "joining":
      return { kind: "joining" };
    case "reconnecting":
      return { kind: "reconnecting" };
    case "live":
    case "leaving":
      return { kind: "call" };
    case "left":
      if (leftByChoice) return { kind: "status", outcome: "left" };
      return { kind: "status", outcome: connection.removedByHost ? "removed" : "exited" };
    case "failed":
      return { kind: "status", outcome: "failed" };
  }
}
