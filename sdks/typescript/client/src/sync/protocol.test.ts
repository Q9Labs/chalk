import { describe, expect, it } from "vitest";
import { jsonSyncProtocolCodec } from "./protocol";

describe("jsonSyncProtocolCodec", () => {
  it("encodes client frames and rejects server values without a frame type", () => {
    const hello = { type: "hello" as const, protocol: 2 as const, token: "token", streams: { control: { cursor: null } } };

    expect(jsonSyncProtocolCodec.encodeClient(hello)).toBe(JSON.stringify(hello));
    expect(jsonSyncProtocolCodec.decodeServer('{"type":"pong"}')).toEqual({ type: "pong" });
    expect(() => jsonSyncProtocolCodec.decodeServer("null")).toThrow("missing its type");
    expect(() => jsonSyncProtocolCodec.decodeServer('{"type":1}')).toThrow("missing its type");
  });
});
