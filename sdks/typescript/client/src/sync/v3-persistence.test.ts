import { describe, expect, it } from "vitest";
import { compareV3PendingTargets, InMemoryV3PendingTargetStore } from "./v3-persistence";
import type { V3PendingTarget } from "./v3-types";

describe("in-memory v3 pending-target persistence", () => {
  it("clones values, sorts deterministically, replaces by command ID, and removes", async () => {
    const later = pendingTarget("018f2f65-2a77-7a44-8e9a-5b0b6f8d4e12", 20, "Later");
    const earlier = pendingTarget("018f2f65-2a77-7a44-8e9a-5b0b6f8d4e11", 10, "Earlier");
    const store = new InMemoryV3PendingTargetStore([later, earlier]);

    const loaded = await store.load();
    expect(loaded.map((target) => target.commandId)).toEqual([earlier.commandId, later.commandId]);
    expect(loaded[0]).not.toBe(earlier);
    expect(compareV3PendingTargets(earlier, later)).toBeLessThan(0);

    const replacement = pendingTarget(earlier.commandId, 30, "Replacement");
    await store.put(replacement);
    expect((await store.load()).map((target) => target.command.payload)).toEqual([{ display_name: "Later" }, { display_name: "Replacement" }]);

    await store.remove(later.commandId);
    expect(await store.load()).toEqual([replacement]);
  });
});

function pendingTarget(commandId: string, createdAt: number, displayName: string): V3PendingTarget {
  return {
    commandId,
    createdAt,
    bytes: 128,
    command: { name: "set_display_name", payload: { display_name: displayName } },
  };
}
