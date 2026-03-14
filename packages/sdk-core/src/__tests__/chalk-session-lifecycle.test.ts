import { describe, expect, it } from "bun:test";
import { ChalkSession } from "../session/chalk-session";
import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";

const createSession = (): ChalkSession =>
  new ChalkSession({
    apiUrl: "https://api.chalk.test",
    token: "test-token",
  });

describe("ChalkSession lifecycle listener graph", () => {
  it("constructs safely when window exists without DOM event APIs", () => {
    const originalWindow = globalThis.window;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { innerWidth: 390 },
    });

    try {
      const session = createSession();
      expect(session.ui.getState().isMobileView).toBe(false);
      session.dispose();
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: originalWindow,
      });
    }
  });

  it("keeps a single external forwarding graph when setup runs multiple times", () => {
    const session = createSession();

    expect(session.room._emitter.listenerCount("connected")).toBe(1);
    expect(session.room._emitter.listenerCount("disconnected")).toBe(1);
    expect(session.room._emitter.listenerCount("status:changed")).toBe(1);
    expect(session.room._emitter.listenerCount("error")).toBe(1);
    expect(session.media._emitter.listenerCount("error")).toBe(1);

    (session as any).setupEventForwarding();

    expect(session.room._emitter.listenerCount("connected")).toBe(1);
    expect(session.room._emitter.listenerCount("disconnected")).toBe(1);
    expect(session.room._emitter.listenerCount("status:changed")).toBe(1);
    expect(session.room._emitter.listenerCount("error")).toBe(1);
    expect(session.media._emitter.listenerCount("error")).toBe(1);

    let connectedCount = 0;
    let errorCount = 0;
    session.on("connected", () => {
      connectedCount += 1;
    });
    session.on("error", () => {
      errorCount += 1;
    });

    session.room._emitter.emit("connected", { roomId: "room-1" });
    session.media._emitter.emit("error", new ChalkError(ChalkErrorCode.MEDIA_ERROR, "media test"));

    expect(connectedCount).toBe(1);
    expect(errorCount).toBe(1);

    session.dispose();
  });

  it("tears down external forwarding subscriptions on dispose", () => {
    const session = createSession();

    expect(session.room._emitter.listenerCount("connected")).toBe(1);
    expect(session.media._emitter.listenerCount("error")).toBe(1);

    session.dispose();

    expect(session.room._emitter.listenerCount("connected")).toBe(0);
    expect(session.room._emitter.listenerCount("disconnected")).toBe(0);
    expect(session.room._emitter.listenerCount("status:changed")).toBe(0);
    expect(session.room._emitter.listenerCount("error")).toBe(0);
    expect(session.media._emitter.listenerCount("error")).toBe(0);
  });
});
