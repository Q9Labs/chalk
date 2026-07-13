import { describe, expect, it } from "vitest";
import { decodeV3ClientFrame, decodeV3ServerFrame, encodeV3ClientFrame } from "./v3-codec";

const commandId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4e01";

describe("SyncEngine v3 codec", () => {
  it("round-trips approved frames and rejects aliases or unknown fields", () => {
    const command = {
      type: "command",
      command_id: commandId,
      name: "set_hand_raised",
      payload: { raised: true },
    } as const;

    expect(JSON.parse(encodeV3ClientFrame(command))).toEqual(command);
    expect(decodeV3ClientFrame(command)).toEqual(command);
    expect(decodeV3ServerFrame('{"type":"pong"}')).toEqual({ type: "pong" });

    expect(() => decodeV3ClientFrame({ ...command, name: "raise_hand" })).toThrow();
    expect(() => decodeV3ServerFrame('{"type":"pong","extra":true}')).toThrow();
  });
});
