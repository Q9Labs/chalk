import { afterEach, describe, expect, it } from "vitest";
import { diagnosticRuntime } from "../episode-diagnostic-runtime.test.helpers";
import { ControllerHarness, disposeControllerRuntimes, snapshot } from "./controller-parity.test.helpers";

afterEach(disposeControllerRuntimes);

describe("ParticipantsController", () => {
  it("records moderation success, failure, and conditional target visibility", async () => {
    const diagnostics = diagnosticRuntime();
    const harness = new ControllerHarness();
    const { controller, runtime } = harness.participants(diagnostics);
    harness.connect();

    await runtime.runPromise(controller.assignRole("participant-2", "observer"));
    const success = diagnostics.inspect().ring.filter((event) => event.name === "moderation.role.change");
    expect(success.map((event) => event.expectation?.checkpoint)).toEqual(expect.arrayContaining(["capability_decision", "command_commit", "target_application"]));
    expect(success.some((event) => event.state === "not_observable")).toBe(true);

    harness.sync.muteParticipant.mockRejectedValueOnce(new Error("rejected"));
    await expect(runtime.runPromise(controller.mute("participant-2"))).rejects.toBeDefined();
    expect(diagnostics.inspect().ring.at(-1)).toMatchObject({ name: "moderation.microphone.disable", state: "failed" });
    diagnostics.dispose();
  });

  it("projects participant media and negotiated collaboration capabilities, maps commands, and clears the roster on leave", async () => {
    const harness = new ControllerHarness(
      snapshot({
        media: {
          projectionId: "media-1",
          sequence: 1,
          items: [
            { participantId: "participant-1", source: "microphone", enabled: true, publicationId: "publication-1" },
            { participantId: "participant-2", source: "camera", enabled: true, publicationId: "publication-2" },
          ],
        },
      }),
    );
    harness.sync.collaborationCapabilities = { "participant-1": ["sendReaction", "sendChat"], "participant-2": ["sendChat"] };
    const { controller, runtime } = harness.participants();

    harness.connect();
    const projected = harness.store.getSnapshot();
    expect(projected.participants).toMatchObject({
      roster: [
        { participantId: "participant-1", media: { microphone: "active", camera: "inactive", screenShare: "inactive" }, capabilities: ["publishAudio", "sendReaction", "sendChat"] },
        { participantId: "participant-2", media: { microphone: "inactive", camera: "active", screenShare: "inactive" }, capabilities: ["subscribe", "sendChat"] },
      ],
      admissionQueue: [{ requestId: "admission-1", participantId: "pending-1", displayName: "Pending" }],
    });
    expect(projected.self.can("sendReaction")).toBe(true);
    expect(projected.self.can("manageAdmission")).toBe(false);

    const stable = harness.store.getSnapshot();
    harness.sync.emit();
    expect(harness.store.getSnapshot().participants).toBe(stable.participants);
    expect(harness.store.getSnapshot().self).toBe(stable.self);

    await runtime.runPromise(controller.assignRole("participant-2", "observer"));
    await runtime.runPromise(controller.mute("participant-2"));
    await runtime.runPromise(controller.stopVideo("participant-2"));
    await runtime.runPromise(controller.stopScreenShare("participant-2"));
    await expect(runtime.runPromise(controller.requestMedia("participant-2", "microphone"))).resolves.toEqual({ status: "delivered", requestId: "request-1" });
    await expect(runtime.runPromise(controller.requestMedia("participant-2", "camera"))).resolves.toEqual({ status: "delivered", requestId: "request-2" });
    await runtime.runPromise(controller.remove("participant-2"));
    await runtime.runPromise(controller.admit("admission-1"));
    await runtime.runPromise(controller.deny("admission-2"));
    await runtime.runPromise(controller.raiseHand());
    await runtime.runPromise(controller.lowerHand());
    await runtime.runPromise(controller.renameSelf("Ada Lovelace"));

    expect(harness.sync.assignRole).toHaveBeenCalledWith("participant-2", "observer");
    expect(harness.sync.muteParticipant).toHaveBeenCalledWith("participant-2");
    expect(harness.sync.stopParticipantCamera).toHaveBeenCalledWith("participant-2");
    expect(harness.sync.stopParticipantScreenShare).toHaveBeenCalledWith("participant-2");
    expect(harness.sync.requestUnmute).toHaveBeenCalledWith("participant-2");
    expect(harness.sync.requestStartCamera).toHaveBeenCalledWith("participant-2");
    expect(harness.sync.removeParticipant).toHaveBeenCalledWith("participant-2");
    expect(harness.sync.admit).toHaveBeenCalledWith("admission-1");
    expect(harness.sync.deny).toHaveBeenCalledWith("admission-2");
    expect(harness.sync.setHandRaised).toHaveBeenNthCalledWith(1, true);
    expect(harness.sync.setHandRaised).toHaveBeenNthCalledWith(2, false);
    expect(harness.sync.setDisplayName).toHaveBeenCalledWith("Ada Lovelace");
    await expect(runtime.runPromise(controller.renameSelf(" Ada "))).rejects.toMatchObject({ code: "participant.invalid" });
    await expect(runtime.runPromise(controller.requestMedia("participant-2", "screen" as never))).rejects.toMatchObject({ code: "participant.invalid" });

    harness.disconnect();
    expect(harness.store.getSnapshot()).toMatchObject({ self: { participantId: null, capabilities: [] }, participants: { roster: [], admissionQueue: [] } });
  });
});
