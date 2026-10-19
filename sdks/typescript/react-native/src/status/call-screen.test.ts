import { describe, expect, it } from "vitest";
import { callScreen } from "./call-screen";

const connection = (status: Parameters<typeof callScreen>[0]["status"], code?: "episode.ended" | "access.invalid") => ({ status, episode: null, lastError: code ? { code, recoverable: false, message: "" } : null });

describe("callScreen", () => {
  it("covers the call while it joins or reconnects", () => {
    expect(callScreen(connection("joining"), false)).toEqual({ kind: "joining" });
    expect(callScreen(connection("reconnecting"), false)).toEqual({ kind: "reconnecting" });
    expect(callScreen(connection("live"), false)).toEqual({ kind: "call" });
  });

  it("tells leaving, being removed, an ended call and a failure apart", () => {
    expect(callScreen(connection("left"), true)).toEqual({ kind: "status", outcome: "left" });
    expect(callScreen(connection("left"), false)).toEqual({ kind: "status", outcome: "removed" });
    expect(callScreen(connection("left", "episode.ended"), true)).toEqual({ kind: "status", outcome: "ended" });
    expect(callScreen(connection("failed", "access.invalid"), false)).toEqual({ kind: "status", outcome: "failed" });
  });
});
