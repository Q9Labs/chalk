import { describe, expect, it } from "vitest";
import { isPendingCommand } from "./pending-command-validation";

const command = {
  commandId: "command-00000001",
  command: { name: "raise_hand" },
  createdAt: 2,
  bytes: 42,
};

describe("isPendingCommand", () => {
  it("accepts supported commands", () => {
    expect(isPendingCommand(command)).toBe(true);
    expect(isPendingCommand({ ...command, command: { name: "lower_hand" } })).toBe(true);
  });

  it("rejects malformed persisted records", () => {
    for (const value of [null, {}, { ...command, commandId: 1 }, { ...command, command: { name: "unknown" } }, { ...command, createdAt: "2" }, { ...command, bytes: "42" }]) {
      expect(isPendingCommand(value)).toBe(false);
    }
  });
});
