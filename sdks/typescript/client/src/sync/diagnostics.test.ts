import { describe, expect, it } from "vitest";
import { SyncDiagnosticBuffer } from "./diagnostics";

describe("SyncDiagnosticBuffer", () => {
  it("drops the oldest entry at capacity and returns isolated snapshots", () => {
    const buffer = new SyncDiagnosticBuffer(1);
    buffer.add({ at: 1, kind: "connection", code: "first", details: { attempt: 1 } });
    buffer.add({ at: 2, kind: "protocol", code: "second", details: { size: 2 } });
    const snapshot = buffer.snapshot();
    (snapshot.entries[0]?.details as { size: number }).size = 99;

    expect(snapshot).toEqual({ entries: [{ at: 2, kind: "protocol", code: "second", details: { size: 99 } }], dropped: 1 });
    expect(buffer.snapshot()).toEqual({ entries: [{ at: 2, kind: "protocol", code: "second", details: { size: 2 } }], dropped: 1 });
  });

  it("requires a positive integral capacity", () => {
    expect(() => new SyncDiagnosticBuffer(0)).toThrow("positive integer");
  });
});
