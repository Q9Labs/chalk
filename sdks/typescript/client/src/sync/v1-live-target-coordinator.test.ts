import { expect, it, vi } from "vitest";
import type { ClientMediaPlane, MediaPlaneTarget } from "../media/plane";
import { V1LiveTargetCoordinator } from "./v1-live-target-coordinator";
import type { V1LiveTargetResult } from "./v1-types";

const OPERATION_ID = "operation-0000000001";

function result(outcome: V1LiveTargetResult["outcome"], errorCode: string | null = null): V1LiveTargetResult {
  return { type: "live_target_result", operation_id: OPERATION_ID, name: "set_camera_enabled", outcome, error_code: errorCode };
}

type Timer = { readonly milliseconds: number; readonly run: () => void };

function harness(plane: Partial<ClientMediaPlane>) {
  const events: string[] = [];
  const timers: Timer[] = [];
  const mediaPlane: ClientMediaPlane = {
    observeLocalPublications: () => () => {},
    observeRemotePublications: () => () => {},
    setLocalPublicationTarget: async () => ({ outcome: "confirmed", errorCode: null }),
    ...plane,
  };
  const coordinator = new V1LiveTargetCoordinator({
    mediaPlane,
    requestIds: { next: () => OPERATION_ID },
    retryDelayMs: undefined,
    clock: () => ({
      now: () => 0,
      setTimeout: (run, milliseconds) => timers.push({ milliseconds, run }) - 1,
      clearTimeout: (timer) => void timers.splice(Number(timer), 1, { milliseconds: 0, run: () => {} }),
    }),
    participantId: () => "participant-1",
    isLive: () => true,
    requestIdInUse: () => false,
    assertCapacity: () => {},
    sendIfLive: (frame) => events.push(`frame:${frame.type}`),
    stateChanged: () => {},
  });
  return { coordinator, events, timers };
}

it("starts the grant-independent media work before live_target_result and publishes only after it", async () => {
  const targets: MediaPlaneTarget[] = [];
  const { coordinator, events } = harness({
    prepareLocalPublicationTarget: async (target) => {
      targets.push(target);
      events.push("prepare");
    },
    setLocalPublicationTarget: async () => {
      events.push("publish");
      return { outcome: "confirmed", errorCode: null };
    },
  });

  const enabling = coordinator.send("set_camera_enabled", "camera", true);
  await vi.waitFor(() => expect(events).toContain("prepare"));
  expect(events).toEqual(["frame:live_target", "prepare"]);
  expect(targets).toEqual([{ operationId: OPERATION_ID, participantId: "participant-1", source: "camera", enabled: true }]);

  coordinator.receive(result("confirmed"));
  await expect(enabling).resolves.toMatchObject({ serverOutcome: "confirmed", mediaPlaneOutcome: "confirmed" });
  expect(events).toEqual(["frame:live_target", "prepare", "publish"]);
});

it("never publishes when the grant is denied, and the denial still reaches the caller", async () => {
  const setLocalPublicationTarget = vi.fn(async () => ({ outcome: "confirmed" as const, errorCode: null }));
  const prepareLocalPublicationTarget = vi.fn(async () => {});
  const { coordinator } = harness({ prepareLocalPublicationTarget, setLocalPublicationTarget });

  const enabling = coordinator.send("set_camera_enabled", "camera", true);
  const denied = expect(enabling).rejects.toMatchObject({ code: "terminal_failure" });
  await vi.waitFor(() => expect(prepareLocalPublicationTarget).toHaveBeenCalledTimes(1));
  coordinator.receive(result("terminal_failure", "not_allowed"));

  await denied;
  expect(setLocalPublicationTarget).not.toHaveBeenCalled();
  expect(coordinator.getLocalMedia().camera).toBe("failed");
  expect(coordinator.pendingCount).toBe(0);
});

it("does not let a failed head start fail the enable", async () => {
  const setLocalPublicationTarget = vi.fn(async () => ({ outcome: "confirmed" as const, errorCode: null }));
  const { coordinator } = harness({
    prepareLocalPublicationTarget: async () => {
      throw new Error("replacement failed");
    },
    setLocalPublicationTarget,
  });

  const enabling = coordinator.send("set_camera_enabled", "camera", true);
  coordinator.receive(result("confirmed"));

  await expect(enabling).resolves.toMatchObject({ mediaPlaneOutcome: "confirmed" });
  expect(setLocalPublicationTarget).toHaveBeenCalledTimes(1);
});

it("prepares nothing for an off target", async () => {
  const prepareLocalPublicationTarget = vi.fn(async () => {});
  const { coordinator } = harness({ prepareLocalPublicationTarget });

  const disabling = coordinator.send("set_camera_enabled", "camera", false);
  coordinator.receive(result("confirmed"));

  await disabling;
  expect(prepareLocalPublicationTarget).not.toHaveBeenCalled();
});

it("enables on a media plane that has no head start", async () => {
  const { coordinator } = harness({});

  const enabling = coordinator.send("set_camera_enabled", "camera", true);
  coordinator.receive(result("confirmed"));

  await expect(enabling).resolves.toMatchObject({ mediaPlaneOutcome: "confirmed" });
});

// A parked track the plane resumed ahead of the grant forwards under the node's lease, so the target that started it undoes it
// on every path that does not execute the enable.
function headStartPlane() {
  const calls: string[] = [];
  const plane: Partial<ClientMediaPlane> = {
    prepareLocalPublicationTarget: async () => void calls.push("prepare"),
    cancelPreparedLocalPublicationTarget: async (target) => void calls.push(`cancel:${target.source}`),
    setLocalPublicationTarget: async () => {
      calls.push("set");
      return { outcome: "confirmed", errorCode: null };
    },
  };
  return { calls, plane };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("undoes the head start at the first retryable refusal only, and the final grant enables through the normal step", async () => {
  const { calls, plane } = headStartPlane();
  const { coordinator } = harness(plane);

  const enabling = coordinator.send("set_camera_enabled", "camera", true);
  await settle();
  coordinator.receive(result("retryable_failure", "busy"));
  await settle();
  expect(calls).toEqual(["prepare", "cancel:camera"]);

  coordinator.receive(result("retryable_failure", "busy"));
  await settle();
  expect(calls).toEqual(["prepare", "cancel:camera"]);

  coordinator.receive(result("confirmed"));
  await expect(enabling).resolves.toMatchObject({ mediaPlaneOutcome: "confirmed" });
  expect(calls).toEqual(["prepare", "cancel:camera", "set"]);
});

it("undoes the head start when the grant is refused for good, after the head start has finished", async () => {
  const calls: string[] = [];
  const headStart = Promise.withResolvers<void>();
  const { coordinator } = harness({
    prepareLocalPublicationTarget: async () => {
      await headStart.promise;
      calls.push("prepared");
    },
    cancelPreparedLocalPublicationTarget: async () => void calls.push("cancel"),
  });

  const enabling = coordinator.send("set_camera_enabled", "camera", true);
  const refused = expect(enabling).rejects.toMatchObject({ code: "terminal_failure" });
  coordinator.receive(result("terminal_failure", "not_allowed"));
  await refused;
  await settle();
  expect(calls).toEqual([]);

  headStart.resolve();
  await settle();
  expect(calls).toEqual(["prepared", "cancel"]);
});

it("undoes the head start when the retry budget runs out and when the local step times out", async () => {
  for (const [timer, code] of [
    [15_000, "retry_exhausted"],
    [45_000, "media_timeout"],
  ] as const) {
    const { calls, plane } = headStartPlane();
    const { coordinator, timers } = harness({ ...plane, setLocalPublicationTarget: () => new Promise(() => {}) });

    const enabling = coordinator.send("set_camera_enabled", "camera", true);
    await settle();
    if (timer === 45_000) coordinator.receive(result("confirmed"));
    const expired = expect(enabling).rejects.toMatchObject({ code });
    timers.find((candidate) => candidate.milliseconds === timer)?.run();
    await expired;
    await settle();
    expect(calls).toEqual(["prepare", "cancel:camera"]);
  }
});

it("undoes the head start when the connection drops before an answer", async () => {
  const { calls, plane } = headStartPlane();
  const { coordinator } = harness(plane);

  const enabling = coordinator.send("set_camera_enabled", "camera", true);
  const dropped = expect(enabling).rejects.toMatchObject({ code: "disconnected_before_delivery" });
  await settle();
  coordinator.disconnect("disconnected_before_delivery");
  await dropped;
  await settle();
  expect(calls).toEqual(["prepare", "cancel:camera"]);
});

it("keeps the head start for a granted enable, and starts none for an off target", async () => {
  const { calls, plane } = headStartPlane();
  const { coordinator } = harness(plane);

  const enabling = coordinator.send("set_camera_enabled", "camera", true);
  await settle();
  coordinator.receive(result("confirmed"));
  await enabling;
  const disabling = coordinator.send("set_camera_enabled", "camera", false);
  coordinator.receive(result("terminal_failure", "not_allowed"));
  await expect(disabling).rejects.toMatchObject({ code: "terminal_failure" });
  await settle();
  expect(calls).toEqual(["prepare", "set"]);
});
