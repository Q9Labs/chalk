import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SyncV1ClientFrameSchema } from "../generated/sync";

const hello = (extra: Record<string, unknown>) => ({
  type: "hello",
  protocol: 1,
  token: "test-token",
  streams: { control: { cursor: null }, media: { cursor: null }, presence: { cursor: null }, requests: { cursor: null } },
  ...extra,
});

describe("hello baggage", () => {
  const decode = (frame: unknown) => Schema.decodeUnknownSync(SyncV1ClientFrameSchema)(frame);

  it("accepts the session baggage member next to the other correlation fields", () => {
    expect(() => decode(hello({ baggage: "session.id=3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c", journey_id: "00000000-0000-4000-8000-000000000042" }))).not.toThrow();
  });

  it("rejects a baggage value that is not exactly one lowercase session.id member", () => {
    for (const baggage of ["session.id=3F2B8C1E-5D4A-4E7B-9A6C-1D2E3F4A5B6C", "other=3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c", "session.id=not-a-uuid"]) {
      expect(() => decode(hello({ baggage }))).toThrow();
    }
  });

  it("does not allow baggage on other client frames", () => {
    expect(() => decode({ type: "request_ack", request_id: "request-00000001", baggage: "session.id=3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c" })).toThrow();
  });
});
