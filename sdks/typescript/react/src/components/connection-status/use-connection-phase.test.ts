import { expect, it } from "vitest";
import { RECONNECT_NOTICE_MS, nextPhase, type ConnectionPhase } from "./use-connection-phase";

const live: ConnectionPhase = { kind: "live" };

it("starts counting when the status turns reconnecting and keeps that moment while it stays so", () => {
  const dropped = nextPhase(live, "reconnecting", 1_000);
  expect(dropped).toEqual({ kind: "reconnecting", since: 1_000 });
  expect(nextPhase(dropped, "reconnecting", 9_000)).toBe(dropped);
});

it("confirms the return only when the card had time to show", () => {
  const dropped = nextPhase(live, "reconnecting", 1_000);
  expect(nextPhase(dropped, "live", 1_000 + RECONNECT_NOTICE_MS)).toEqual({ kind: "reconnected", awayMs: RECONNECT_NOTICE_MS });
  expect(nextPhase(dropped, "live", 1_000 + RECONNECT_NOTICE_MS - 1)).toEqual(live);
});

it("keeps the confirmation until its timer clears it", () => {
  const back: ConnectionPhase = { kind: "reconnected", awayMs: 14_000 };
  expect(nextPhase(back, "live", 99_000)).toBe(back);
});

it("moves to failed from a drop and rejoins from failed once the status is live again", () => {
  const dropped = nextPhase(live, "reconnecting", 1_000);
  const failed = nextPhase(dropped, "failed", 60_000);
  expect(failed).toEqual({ kind: "failed" });
  expect(nextPhase(failed, "failed", 61_000)).toBe(failed);
  expect(nextPhase(failed, "joining", 62_000)).toEqual(live);
  expect(nextPhase(failed, "live", 63_000)).toEqual(live);
});
