import { describe, expect, it } from "vitest";
import { comparePendingCommands, InMemoryPendingCommandStore } from "./persistence";
import type { PendingCommand } from "./types";

describe("InMemoryPendingCommandStore", () => {
  it("orders pending commands and isolates loaded records from mutation", async () => {
    const later: PendingCommand = { commandId: "command-b", command: { name: "raise_hand", payload: { state: true } }, createdAt: 2, bytes: 42 };
    const first: PendingCommand = { commandId: "command-a", command: { name: "lower_hand" }, createdAt: 1, bytes: 42 };
    const store = new InMemoryPendingCommandStore([later, first]);
    const loaded = await store.load();
    (loaded[0] as { commandId: string }).commandId = "mutated-command-id";
    ((loaded[1]?.command.payload ?? {}) as { state: boolean }).state = false;

    expect((await store.load()).map((command) => command.commandId)).toEqual(["command-a", "command-b"]);
    expect((await store.load())[1]?.command.payload).toEqual({ state: true });
    expect(comparePendingCommands(later, { ...later, commandId: "command-c" })).toBeLessThan(0);
  });
});
