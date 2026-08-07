import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import { diagnosticRuntime } from "../episode-diagnostic-runtime.test.helpers";
import type { Reaction } from "./types";
import { ControllerHarness, disposeControllerRuntimes, reaction, START } from "./controller-parity.test.helpers";

afterEach(disposeControllerRuntimes);

describe("ReactionsController", () => {
  it("records reaction checkpoints and conditional recipient visibility", async () => {
    const diagnostics = diagnosticRuntime();
    const harness = new ControllerHarness();
    const { controller, runtime } = harness.reactions(diagnostics);
    await runtime.runPromise(TestClock.setTime(START));
    harness.connect();

    await runtime.runPromise(controller.send("🎉"));
    const events = diagnostics.inspect().ring.filter((event) => event.name === "reaction.send");
    expect(events.map((event) => event.expectation?.checkpoint)).toEqual(expect.arrayContaining(["authorization", "accepted_commit", "sender_result", "recipient_projection"]));
    expect(events.some((event) => event.state === "not_observable")).toBe(true);

    harness.sync.sendReaction.mockRejectedValueOnce(new Error("rejected"));
    await expect(runtime.runPromise(controller.send("👍"))).rejects.toBeDefined();
    expect(diagnostics.inspect().ring.at(-1)).toMatchObject({ name: "reaction.send", state: "failed" });
    diagnostics.dispose();
  });

  it("validates, deduplicates, bounds, expires, and clears reactions", async () => {
    const harness = new ControllerHarness();
    const { controller, runtime } = harness.reactions();
    await runtime.runPromise(TestClock.setTime(START));
    harness.connect();

    await expect(runtime.runPromise(controller.send("🔥" as Reaction))).rejects.toMatchObject({ code: "reaction.invalid" });
    await expect(runtime.runPromise(controller.send("🎉"))).resolves.toMatchObject({ eventId: "reaction-1", participantId: "participant-1" });
    harness.sync.emitReaction(reaction("reaction-1", "🎉", 5_000));
    expect(harness.store.getSnapshot().reactions.active).toHaveLength(1);

    for (let index = 2; index <= 25; index += 1) harness.sync.emitReaction(reaction(`reaction-${index}`, "👍", 60_000));
    expect(harness.store.getSnapshot().reactions.active).toHaveLength(24);
    expect(harness.store.getSnapshot().reactions.active.some((value) => value.eventId === "reaction-1")).toBe(false);

    harness.sync.emitReaction(reaction("expires-soon", "😂", 1_000));
    await runtime.runPromise(TestClock.adjust(1_000));
    expect(harness.store.getSnapshot().reactions.active.some((value) => value.eventId === "expires-soon")).toBe(false);

    harness.disconnect();
    expect(harness.store.getSnapshot().reactions.active).toEqual([]);
  });
});
