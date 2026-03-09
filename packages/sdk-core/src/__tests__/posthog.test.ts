import { describe, expect, it, mock } from "bun:test";
import { ChalkPostHogSessionReplay } from "../posthog.ts";

describe("ChalkPostHogSessionReplay", () => {
  it("starts recording and captures joined lifecycle event", () => {
    const posthog = {
      startSessionRecording: mock(() => {}),
      stopSessionRecording: mock(() => {}),
      capture: mock(() => {}),
    };
    const replay = new ChalkPostHogSessionReplay();
    replay.configure({
      client: posthog,
      properties: { env: "test" },
    });

    replay.trackJoinSucceeded({
      roomId: "room_1",
      participantId: "p_1",
      role: "host",
      displayName: "Alice",
      demoMode: false,
    });

    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith(
      "chalk_sdk_session_joined",
      expect.objectContaining({
        roomId: "room_1",
        participantId: "p_1",
        role: "host",
        displayName: "Alice",
        demoMode: false,
        env: "test",
      }),
    );
  });

  it("captures leave event and stops replay", () => {
    const posthog = {
      startSessionRecording: mock(() => {}),
      stopSessionRecording: mock(() => {}),
      capture: mock(() => {}),
    };
    const replay = new ChalkPostHogSessionReplay();
    replay.configure({ client: posthog });

    replay.trackLeave({
      reason: "disconnect",
      roomId: "room_1",
      participantId: "p_1",
      demoMode: false,
    });

    expect(posthog.capture).toHaveBeenCalledWith(
      "chalk_sdk_session_left",
      expect.objectContaining({
        reason: "disconnect",
        roomId: "room_1",
        participantId: "p_1",
      }),
    );
    expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("captures join failure event with custom prefix", () => {
    const posthog = {
      capture: mock(() => {}),
    };
    const replay = new ChalkPostHogSessionReplay();
    replay.configure({
      client: posthog,
      eventPrefix: "chalk",
    });

    replay.trackJoinFailed({
      roomId: "room_1",
      displayName: "Alice",
      error: "join failed",
      demoMode: false,
    });

    expect(posthog.capture).toHaveBeenCalledWith(
      "chalk_session_join_failed",
      expect.objectContaining({
        roomId: "room_1",
        displayName: "Alice",
        error: "join failed",
      }),
    );
  });

  it("never throws when PostHog methods throw", () => {
    const replay = new ChalkPostHogSessionReplay();
    replay.configure({
      client: {
        startSessionRecording: mock(() => {
          throw new Error("start failed");
        }),
        stopSessionRecording: mock(() => {
          throw new Error("stop failed");
        }),
        capture: mock(() => {
          throw new Error("capture failed");
        }),
      },
    });

    expect(() =>
      replay.trackJoinSucceeded({
        roomId: "room_1",
        participantId: "p_1",
        role: "host",
        displayName: "Alice",
        demoMode: false,
      }),
    ).not.toThrow();
    expect(() =>
      replay.trackLeave({
        reason: "switch_room",
        roomId: "room_1",
        participantId: "p_1",
        demoMode: false,
      }),
    ).not.toThrow();
    expect(() =>
      replay.trackJoinFailed({
        roomId: "room_1",
        displayName: "Alice",
        error: "join failed",
        demoMode: false,
      }),
    ).not.toThrow();
  });
});
