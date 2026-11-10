import { expect, it, vi } from "vitest";
import type { ClientMediaPlane, MediaPlaneTarget } from "../media/plane";
import { V1LiveTargetCoordinator } from "./v1-live-target-coordinator";
import type { V1LiveTargetResult } from "./v1-types";

const OPERATION_ID = "operation-0000000001";

function result(outcome: V1LiveTargetResult["outcome"], errorCode: string | null = null): V1LiveTargetResult {
  return { type: "live_target_result", operation_id: OPERATION_ID, name: "set_camera_enabled", outcome, error_code: errorCode };
}

function harness(plane: Partial<ClientMediaPlane>) {
  const events: string[] = [];
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
    clock: () => ({ now: () => 0, setTimeout: () => 0, clearTimeout: () => {} }),
    participantId: () => "participant-1",
    isLive: () => true,
    requestIdInUse: () => false,
    assertCapacity: () => {},
    sendIfLive: (frame) => events.push(`frame:${frame.type}`),
    stateChanged: () => {},
  });
  return { coordinator, events };
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
