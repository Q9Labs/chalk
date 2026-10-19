import type { ConnectionSlice } from "@q9labsai/chalk-client";
import type { CallOutcome } from "./StatusPage";

/** What covers the call: nothing, a limbo card over the veiled call, or a status page. */
export type CallScreen = { readonly kind: "call" } | { readonly kind: "joining" } | { readonly kind: "reconnecting" } | { readonly kind: "status"; readonly outcome: CallOutcome };

/**
 * Reads the screen from the connection. `leftByChoice` is true once the person pressed Leave or
 * End: the server ends a removed person's connection the same way, so a leave nobody asked for
 * means the host removed them.
 */
export function callScreen(connection: ConnectionSlice, leftByChoice: boolean): CallScreen {
  if (connection.lastError?.code === "episode.ended") return { kind: "status", outcome: "ended" };
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
      return { kind: "status", outcome: leftByChoice ? "left" : "removed" };
    case "failed":
      return { kind: "status", outcome: "failed" };
  }
}
