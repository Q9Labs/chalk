import { describe, expect, it } from "vitest";
import { callScreen } from "./call-screen";

type ConnectionOptions = { readonly code?: "episode.ended" | "access.invalid"; readonly episodeEnded?: boolean; readonly removedByHost?: boolean };

const connection = (status: Parameters<typeof callScreen>[0]["status"], { code, episodeEnded = false, removedByHost = false }: ConnectionOptions = {}) => ({
  status,
  episode: null,
  lastError: code ? { code, recoverable: false, message: "" } : null,
  episodeEnded,
  removedByHost,
});

describe("callScreen", () => {
  it("covers the call while it joins or reconnects", () => {
    expect(callScreen(connection("joining"), false)).toEqual({ kind: "joining" });
    expect(callScreen(connection("reconnecting"), false)).toEqual({ kind: "reconnecting" });
    expect(callScreen(connection("live"), false)).toEqual({ kind: "call" });
  });

  it("keeps degraded Sync health on the usable call screen", () => {
    expect(callScreen({ ...connection("live"), syncHealth: "degraded" }, false)).toEqual({ kind: "call" });
  });

  it("shows the person's own leave as left, even when the leave call failed", () => {
    expect(callScreen(connection("left"), true)).toEqual({ kind: "status", outcome: "left" });
    expect(callScreen(connection("left", { removedByHost: true }), true)).toEqual({ kind: "status", outcome: "left" });
  });

  it("shows removed only when the server reported a host removal", () => {
    expect(callScreen(connection("left", { removedByHost: true }), false)).toEqual({ kind: "status", outcome: "removed" });
  });

  it("shows a neutral exit for any other exit nobody asked for", () => {
    expect(callScreen(connection("left"), false)).toEqual({ kind: "status", outcome: "exited" });
  });

  it("shows the call ended when the Episode ends while the person is in it", () => {
    expect(callScreen(connection("left", { episodeEnded: true }), false)).toEqual({ kind: "status", outcome: "ended" });
    expect(callScreen(connection("left", { code: "episode.ended" }), false)).toEqual({ kind: "status", outcome: "ended" });
  });

  it("shows a failure as failed", () => {
    expect(callScreen(connection("failed", { code: "access.invalid" }), false)).toEqual({ kind: "status", outcome: "failed" });
  });
});
