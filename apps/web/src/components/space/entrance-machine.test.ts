import { describe, expect, it } from "vitest";
import { canStart, entranceReducer, initialEntrance, type EndedCall, type Entrance, type EntranceEvent, type JoinedSpace, type WaitingArrival } from "./entrance-machine";
import type { EntryFailure } from "./entry-failure";

// The reducer only moves these values around, so a marker stands in for each.
const joined = { marker: "joined" } as unknown as JoinedSpace;
const waiting = { marker: "waiting" } as unknown as WaitingArrival;
const call = { marker: "call" } as unknown as EndedCall;
const failure: EntryFailure = { message: "No.", retryable: true };

function run(start: Entrance, ...events: readonly EntranceEvent[]): Entrance {
  return events.reduce(entranceReducer, start);
}

describe("entrance reducer", () => {
  it("walks a visitor through the lobby into the call and out to the leave screen", () => {
    const entrance = run(initialEntrance({ resuming: false, stepOpen: true }), { type: "started", fromStep: true }, { type: "waitingForHost", waiting }, { type: "admitted", joined }, { type: "callUiReady" }, { type: "callEnded", call });
    expect(entrance).toEqual({ phase: "ended", call, rejoining: false });
  });

  it("starts one arrival for a double click", () => {
    const started = run(initialEntrance({ resuming: false, stepOpen: false }), { type: "started", fromStep: false });
    expect(run(started, { type: "started", fromStep: false })).toBe(started);
  });

  it("resumes straight into an arrival", () => {
    expect(initialEntrance({ resuming: true, stepOpen: true })).toEqual({ phase: "arriving", stepOpen: false });
  });

  it("ignores an admission that arrives while the visitor is cancelling", () => {
    const cancelling = run(initialEntrance({ resuming: false, stepOpen: false }), { type: "started", fromStep: false }, { type: "waitingForHost", waiting }, { type: "cancelRequested" });
    expect(run(cancelling, { type: "admitted", joined })).toBe(cancelling);
    expect(run(cancelling, { type: "cancelled" })).toEqual({ phase: "idle", stepOpen: true });
  });

  it("goes back to waiting with the error when a cancel fails", () => {
    const cancelling = run(initialEntrance({ resuming: false, stepOpen: false }), { type: "started", fromStep: false }, { type: "waitingForHost", waiting }, { type: "cancelRequested" });
    expect(run(cancelling, { type: "failed", failure })).toEqual({ phase: "waiting", waiting, cancelling: false, failure });
  });

  it("releases the old call before a rejoin arrives, once", () => {
    const ended: Entrance = { phase: "ended", call, rejoining: false };
    const rejoining = run(ended, { type: "started", fromStep: false });
    expect(rejoining).toEqual({ phase: "ended", call, rejoining: true });
    expect(canStart(rejoining)).toBe(false);
    expect(run(rejoining, { type: "started", fromStep: false })).toBe(rejoining);
    expect(run(rejoining, { type: "rejoinReleased" })).toEqual({ phase: "arriving", stepOpen: false });
  });

  it("keeps the leave screen when releasing the old call fails", () => {
    expect(run({ phase: "ended", call, rejoining: true }, { type: "failed", failure })).toEqual({ phase: "ended", call, rejoining: false, failure });
  });

  it("lets a failed entrance start again", () => {
    expect(run({ phase: "failed", failure }, { type: "started", fromStep: false })).toEqual({ phase: "arriving", stepOpen: false });
  });
});
