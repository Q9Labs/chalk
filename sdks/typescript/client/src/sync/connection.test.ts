import { describe, expect, it } from "vitest";
import { reduceConnection } from "./connection";

describe("reduceConnection", () => {
  it("moves through active recovery and retry states", () => {
    const connecting = reduceConnection({ phase: "idle" }, { type: "start" });
    const authenticating = reduceConnection(connecting, { type: "socket_open" });
    const recovering = reduceConnection(authenticating, { type: "hello_sent" });
    const live = reduceConnection(recovering, { type: "recovered" });
    const backoff = reduceConnection(live, { type: "retry", retryAt: 123 });

    expect(connecting).toEqual({ phase: "connecting", attempt: 1 });
    expect(authenticating).toEqual({ phase: "authenticating", attempt: 1 });
    expect(recovering).toEqual({ phase: "recovering", attempt: 1 });
    expect(live).toEqual({ phase: "live", attempt: 0 });
    expect(backoff).toEqual({ phase: "backoff", attempt: 1, retryAt: 123 });
    expect(reduceConnection(backoff, { type: "start" })).toEqual({ phase: "connecting", attempt: 1 });
  });

  it("keeps terminal states out of retry", () => {
    expect(reduceConnection({ phase: "ended", reason: "session_ended" }, { type: "retry", retryAt: 1 })).toEqual({ phase: "ended", reason: "session_ended" });
    expect(reduceConnection({ phase: "live", attempt: 0 }, { type: "rejoin_required" })).toEqual({ phase: "stopped", reason: "rejoin_required" });
  });

  it("preserves state for invalid transition ordering while recording an active recovery", () => {
    const idle = { phase: "idle" as const };
    const recovering = { phase: "recovering" as const, attempt: 2 };

    expect(reduceConnection(idle, { type: "socket_open" })).toEqual(idle);
    expect(reduceConnection(recovering, { type: "recovery_started", recoveryId: "recovery-1" })).toEqual({ phase: "recovering", attempt: 2, recoveryId: "recovery-1" });
  });
});
