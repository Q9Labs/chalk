import { describe, expect, it } from "vitest";
import type { SyncConnectDiagnostic } from "../sync/connect-diagnostics";
import { ConnectionDiagnostics, type ConnectionDiagnostic } from "./diagnostics";

describe("connection diagnostic ownership", () => {
  it("isolates retained Sync evidence from observer and caller mutations", () => {
    const sync = { stage: "hello", opened: true, closeCode: 1012, closeReason: "server draining", durationMs: 1 } satisfies SyncConnectDiagnostic;
    let observed: ConnectionDiagnostic | undefined;
    const diagnostics = new ConnectionDiagnostics({
      now: () => 1,
      onEvent: (event) => {
        observed = event;
        if (event.sync) {
          Reflect.set(event.sync, "closeCode", 4999);
          Reflect.set(event.sync, "closeReason", "observer injected");
        }
      },
    });
    diagnostics.record({ event: "sync_connect_failed", state: "joining", epoch: 1, sync });
    expect(sync).toMatchObject({ closeCode: 1012, closeReason: "server draining" });
    sync.closeCode = 4009;
    sync.closeReason = "caller changed";
    expect(observed?.sync).not.toBe(sync);
    expect(Object.isFrozen(observed?.sync)).toBe(true);
    expect(observed?.sync).toMatchObject({ closeCode: 1012, closeReason: "server draining" });
    expect(diagnostics.snapshot()[0]?.sync).toMatchObject({ closeCode: 1012, closeReason: "server draining" });
  });
});
