import { describe, expect, it, vi } from "vitest";
import { TimeoutError } from "../effect/errors.ts";
import { isRetryableRtkJoinError, joinRealtimeKitWithRetry } from "../conference-client/join-engine.ts";
import { getRtkJoinPolicyForCurrentCohort } from "../rtk-join-policy.ts";

describe("joinRealtimeKitWithRetry", () => {
  it("creates a fresh native join attempt after each timeout", async () => {
    const join = vi.fn(() => Promise.resolve());
    let waitCalls = 0;

    await joinRealtimeKitWithRetry(
      { join },
      {
        cohort: "react-native-default",
        platform: "react-native",
        network: undefined,
        policy: {
          name: "react-native-default",
          timeoutMs: 12000,
          retryDelaysMs: [1000, 2000],
        },
      },
      {
        waitForJoin: async () => {
          waitCalls += 1;
          if (waitCalls < 3) {
            throw new TimeoutError({
              message: "RTK join timed out",
              operation: "rtk.join",
              timeoutMs: 12000,
            });
          }
        },
        isJoinTimeoutError: () => false,
        emitAttemptTelemetry: () => {},
        sleep: async () => {},
      },
    );

    expect(join).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once a non-timeout join error is hit", async () => {
    const join = vi.fn(() => Promise.resolve());

    await expect(
      joinRealtimeKitWithRetry(
        { join },
        {
          cohort: "react-native-default",
          platform: "react-native",
          network: undefined,
          policy: {
            name: "react-native-default",
            timeoutMs: 12000,
            retryDelaysMs: [1000, 2000],
          },
        },
        {
          waitForJoin: async () => {
            throw new Error("room not found");
          },
          isJoinTimeoutError: () => false,
          emitAttemptTelemetry: () => {},
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("room not found");

    expect(join).toHaveBeenCalledTimes(1);
  });

  it("recreates the RTK client after retryable transport failures", async () => {
    const leaveCalls: number[] = [];
    const clients = [
      {
        id: "first",
        join: vi.fn(async () => {}),
        leave: vi.fn(async () => {
          leaveCalls.push(1);
        }),
      },
      {
        id: "second",
        join: vi.fn(async () => {}),
        leave: vi.fn(async () => {
          leaveCalls.push(2);
        }),
      },
    ] as const;
    let created = 0;
    let waitCalls = 0;

    const resolvedClient = await joinRealtimeKitWithRetry(
      async () => clients[created++]!,
      {
        cohort: "react-native-default",
        platform: "react-native",
        network: undefined,
        policy: {
          name: "react-native-default",
          timeoutMs: 12000,
          retryDelaysMs: [1000, 2000],
        },
      },
      {
        waitForJoin: async () => {
          waitCalls += 1;
          if (waitCalls === 1) {
            throw new Error("TransportConnectionError: Socket is not connected");
          }
        },
        isJoinTimeoutError: () => false,
        isRetryableJoinError: isRetryableRtkJoinError,
        emitAttemptTelemetry: () => {},
        sleep: async () => {},
      },
    );

    expect(created).toBe(2);
    expect(clients[0].join).toHaveBeenCalledTimes(1);
    expect(clients[0].leave).toHaveBeenCalledTimes(1);
    expect(clients[1].join).toHaveBeenCalledTimes(1);
    expect(leaveCalls).toEqual([1]);
    expect(resolvedClient).toBe(clients[1]);
  });
});

describe("getRtkJoinPolicyForCurrentCohort", () => {
  it("uses the tighter react-native policy on mobile", () => {
    const originalNavigator = globalThis.navigator;

    Object.defineProperty(globalThis, "navigator", {
      value: {
        ...originalNavigator,
        product: "ReactNative",
      },
      configurable: true,
      writable: true,
    });

    try {
      const selection = getRtkJoinPolicyForCurrentCohort();
      expect(selection.platform).toBe("react-native");
      expect(selection.policy.timeoutMs).toBe(12000);
      expect(selection.policy.retryDelaysMs).toEqual([1000, 2000]);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    }
  });
});
