import { describe, expect, it } from "vitest";
import { decodeV1ClientFrame, decodeV1ServerFrame, encodeV1ClientFrame } from "./v1-codec";

const commandId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4e01";

describe("SyncEngine v1 codec", () => {
  it("round-trips approved frames and rejects aliases or unknown fields", () => {
    const command = {
      type: "command",
      command_id: commandId,
      name: "set_hand_raised",
      payload: { raised: true },
    } as const;

    expect(JSON.parse(encodeV1ClientFrame(command))).toEqual(command);
    expect(decodeV1ClientFrame(command)).toEqual(command);
    expect(decodeV1ServerFrame('{"type":"pong"}')).toEqual({ type: "pong" });

    expect(() => decodeV1ClientFrame({ ...command, name: "raise_hand" })).toThrow();
    expect(() => decodeV1ServerFrame('{"type":"pong","extra":true}')).toThrow();
  });
});
