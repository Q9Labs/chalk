import { describe, expect, it } from "vitest";
import { canStart, entranceReducer, initialEntrance, pendingRelease, type EndedCall, type Entrance, type EntranceEvent, type JoinedSpace, type Release, type WaitingArrival } from "./entrance-machine";
import type { EntryFailure } from "./entry-failure";

// The reducer only moves these values around, so a marker stands in for each.
const joined = { marker: "joined" } as unknown as JoinedSpace;
const waiting = { marker: "waiting" } as unknown as WaitingArrival;
const release: Release = async () => undefined;
const call = { marker: "call", release } as unknown as EndedCall;
const failure: EntryFailure = { message: "No.", retryable: true };

function run(start: Entrance, ...events: readonly EntranceEvent[]): Entrance {
  return events.reduce(entranceReducer, start);
}

const idle = () => initialEntrance({ resuming: false, stepOpen: false });
/** The first arrival: attempt 1, in the lobby. */
const lobby = () => run(idle(), { type: "started", fromStep: false }, { type: "waitingForHost", attempt: 1, waiting });
/** The first arrival is admitted and its call UI failed to load, so the entrance holds the admission until it is released. */
const failedWithAdmission = () => run(idle(), { type: "started", fromStep: false }, { type: "admitted", attempt: 1, joined }, { type: "callUiFailed", attempt: 1, failure, release });

describe("entrance reducer", () => {
  it("walks a visitor through the lobby into the call and out to the leave screen", () => {
    const entrance = run(lobby(), { type: "admitted", attempt: 1, joined }, { type: "callUiReady", attempt: 1 }, { type: "callEnded", call });
    expect(entrance).toEqual({ phase: "ended", attempt: 1, call, rejoining: false });
  });

  it("starts one arrival for a double click", () => {
    const started = run(idle(), { type: "started", fromStep: false });
    expect(run(started, { type: "started", fromStep: false })).toBe(started);
  });

  it("resumes straight into an arrival", () => {
    expect(initialEntrance({ resuming: true, stepOpen: true })).toEqual({ phase: "arriving", attempt: 1, stepOpen: false });
  });

  it("ignores an admission that arrives while the visitor is cancelling", () => {
    const cancelling = run(lobby(), { type: "cancelRequested" });
    expect(run(cancelling, { type: "admitted", attempt: 1, joined })).toBe(cancelling);
    expect(run(cancelling, { type: "cancelled", attempt: 1 })).toEqual({ phase: "idle", attempt: 1, stepOpen: true });
  });

  it("goes back to waiting with the error when a cancel fails", () => {
    const cancelling = run(lobby(), { type: "cancelRequested" });
    expect(run(cancelling, { type: "failed", attempt: 1, failure })).toEqual({ phase: "waiting", attempt: 1, waiting, cancelling: false, failure });
  });

  it("releases the old call before a rejoin arrives, once", () => {
    const ended: Entrance = { phase: "ended", attempt: 1, call, rejoining: false };
    const rejoining = run(ended, { type: "started", fromStep: false });
    expect(rejoining).toEqual({ phase: "ended", attempt: 1, call, rejoining: true });
    expect(canStart(rejoining)).toBe(false);
    expect(run(rejoining, { type: "started", fromStep: false })).toBe(rejoining);
    expect(run(rejoining, { type: "rejoinReleased", attempt: 1 })).toEqual({ phase: "arriving", attempt: 2, stepOpen: false });
  });

  it("keeps the leave screen when releasing the old call fails", () => {
    expect(run({ phase: "ended", attempt: 1, call, rejoining: true }, { type: "failed", attempt: 1, failure })).toEqual({ phase: "ended", attempt: 1, call, rejoining: false, failure });
  });

  it("lets a failed entrance start again", () => {
    expect(run({ phase: "failed", attempt: 1, failure, restarting: false }, { type: "started", fromStep: false })).toEqual({ phase: "arriving", attempt: 2, stepOpen: false });
  });
});

describe("a new arrival after the previous one", () => {
  it("waits for the failed call load to finish leaving, however early Ask again is pressed", () => {
    const failed = failedWithAdmission();
    expect(pendingRelease(failed)).toBe(release);
    const asking = run(failed, { type: "started", fromStep: false });
    expect(asking).toMatchObject({ phase: "failed", attempt: 1, restarting: true });
    expect(run(asking, { type: "started", fromStep: false })).toBe(asking); // no second arrival while the leave runs
    expect(run(asking, { type: "rejoinReleased", attempt: 1 })).toEqual({ phase: "arriving", attempt: 2, stepOpen: false });
  });

  it("stays on the failure, able to retry, when the leave itself fails", () => {
    const asking = run(failedWithAdmission(), { type: "started", fromStep: false });
    const retry = run(asking, { type: "failed", attempt: 1, failure });
    expect(retry).toMatchObject({ phase: "failed", restarting: false, held: release });
    expect(canStart(retry)).toBe(true);
  });

  it("drops a stale admission after a cancel and a new Join", () => {
    const second = run(lobby(), { type: "cancelRequested" }, { type: "cancelled", attempt: 1 }, { type: "started", fromStep: false });
    expect(second).toMatchObject({ phase: "arriving", attempt: 2 });
    expect(run(second, { type: "admitted", attempt: 1, joined })).toBe(second);
    expect(run(second, { type: "waitingForHost", attempt: 1, waiting })).toBe(second);
    expect(run(second, { type: "failed", attempt: 1, failure })).toBe(second);
  });

  it("drops a late answer of the failed arrival once a retry has started", () => {
    const retrying = run(failedWithAdmission(), { type: "started", fromStep: false }, { type: "rejoinReleased", attempt: 1 });
    for (const late of [
      { type: "callUiReady", attempt: 1 },
      { type: "callUiFailed", attempt: 1, failure, release },
      { type: "failed", attempt: 1, failure },
      { type: "rejoinReleased", attempt: 1 },
    ] as const) {
      expect(run(retrying, late)).toBe(retrying);
    }
  });
});

describe("every interleaving", () => {
  const stamps = (attempt: number) => [attempt - 1, attempt, attempt + 1];
  function eventsFrom(entrance: Entrance): EntranceEvent[] {
    const stamped = stamps(entrance.attempt).flatMap((attempt): EntranceEvent[] => [
      { type: "rejoinReleased", attempt },
      { type: "waitingForHost", attempt, waiting },
      { type: "admitted", attempt, joined },
      { type: "failed", attempt, failure },
      { type: "callUiReady", attempt },
      { type: "callUiFailed", attempt, failure, release },
      { type: "cancelled", attempt },
    ]);
    return [{ type: "started", fromStep: false }, { type: "cancelRequested" }, { type: "callEnded", call }, ...stamped];
  }

  /** Walks every state reachable in six events from a fresh page and from a resumed one, with fresh and stale events at each step. */
  function* transitions() {
    let layer: Entrance[] = [idle(), initialEntrance({ resuming: true, stepOpen: false })];
    for (let depth = 0; depth < 6; depth += 1) {
      const next: Entrance[] = [];
      for (const from of layer) {
        for (const event of eventsFrom(from)) {
          const to = entranceReducer(from, event);
          yield { from, event, to };
          if (to !== from) next.push(to);
        }
      }
      layer = next;
    }
  }

  it("changes nothing for an event of another arrival", () => {
    let checked = 0;
    for (const { from, event, to } of transitions()) {
      if ("attempt" in event && event.attempt !== from.attempt) {
        expect(to).toBe(from);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("starts an arrival only when the previous one is fully released", () => {
    let arrivals = 0;
    for (const { from, event, to } of transitions()) {
      if (to.phase !== "arriving" || from.phase === "arriving") continue;
      arrivals += 1;
      expect(to.attempt).toBe(from.attempt + 1);
      if (event.type === "started") expect(pendingRelease(from)).toBeUndefined();
      else {
        expect(event.type).toBe("rejoinReleased");
        expect(pendingRelease(from)).toBeDefined();
        expect(canStart(from)).toBe(false); // the click that asked is already counted
      }
    }
    expect(arrivals).toBeGreaterThan(100);
  });

  it("never lets the attempt go back or skip", () => {
    for (const { from, to } of transitions()) {
      expect([from.attempt, from.attempt + 1]).toContain(to.attempt);
    }
  });
});
