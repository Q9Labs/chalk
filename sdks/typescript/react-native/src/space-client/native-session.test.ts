import { describe, expect, it } from "vitest";
import { createNativeSession, NATIVE_SESSION_BACKGROUND_MS } from "./native-session";

function harness() {
  let now = 1_000;
  let listener: (state: string) => void = () => undefined;
  const session = createNativeSession({
    appState: { addEventListener: (_type, next) => void (listener = next) },
    now: () => now,
  });
  return {
    session,
    move: (state: string, elapsedMs = 0) => {
      now += elapsedMs;
      listener(state);
    },
  };
}

describe("native session", () => {
  const call = {};
  it("keeps the session across a short background stay", () => {
    const { session, move } = harness();
    const first = session.current();
    move("background");
    move("active", NATIVE_SESSION_BACKGROUND_MS - 1);
    expect(session.current()).toBe(first);
  });

  it("starts a new session after 30 minutes in the background", () => {
    const { session, move } = harness();
    const first = session.current();
    move("background");
    move("active", NATIVE_SESSION_BACKGROUND_MS);
    expect(session.current()).not.toBe(first);
    expect(session.current()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("never starts a new session while a call is open", () => {
    const { session, move } = harness();
    const first = session.current();
    session.setCallOpen(call, true);
    move("background");
    move("active", 2 * NATIVE_SESSION_BACKGROUND_MS);
    expect(session.current()).toBe(first);
  });

  it("stays in a call until every client's call has closed", () => {
    const { session, move } = harness();
    const first = session.current();
    const other = {};
    session.setCallOpen(call, true);
    session.setCallOpen(other, true);
    session.setCallOpen(call, false);
    move("background");
    move("active", 2 * NATIVE_SESSION_BACKGROUND_MS);
    expect(session.current()).toBe(first);

    session.setCallOpen(other, false);
    move("background");
    move("active", NATIVE_SESSION_BACKGROUND_MS);
    expect(session.current()).not.toBe(first);
  });

  it("measures each background stay from its own start", () => {
    const { session, move } = harness();
    const first = session.current();
    move("background");
    move("active", 5_000);
    move("background", NATIVE_SESSION_BACKGROUND_MS);
    move("active", 5_000);
    expect(session.current()).toBe(first);
  });
});
