import { describe, expect, it } from "vitest";

import type { ConnectionLifecycleSnapshot } from "../connection";
import { SpaceStore } from "./store";

describe("SpaceStore connection notice", () => {
  it("shows reconnecting for a silent live connection and clears it when Sync responds", () => {
    const store = new SpaceStore();
    const live: ConnectionLifecycleSnapshot = {
      state: "live",
      subject: null,
      episode: null,
      connection: { sync: "healthy", media: "healthy" },
      failure: null,
    };
    store.updateConnection(live);
    expect(store.getSnapshot().connection.status).toBe("live");

    store.updateConnection({ ...live, connection: { sync: "unresponsive", media: "healthy" } });
    expect(store.getSnapshot().connection.status).toBe("reconnecting");

    store.updateConnection({ ...live, connection: { sync: "connecting", media: "healthy" } });
    expect(store.getSnapshot().connection.status).toBe("reconnecting");

    store.updateConnection({ ...live, connection: { sync: "recovering", media: "healthy" } });
    expect(store.getSnapshot().connection.status).toBe("reconnecting");

    store.updateConnection(live);
    expect(store.getSnapshot().connection.status).toBe("live");
  });

  it("does not turn initial Join into a reconnecting notice", () => {
    const store = new SpaceStore();
    store.updateConnection({ state: "joining", subject: null, episode: null, connection: { sync: "connecting", media: "connecting" }, failure: null });
    expect(store.getSnapshot().connection.status).toBe("joining");
  });
});

describe("SpaceStore public error mapping", () => {
  it.each([
    ["sync_start_failed", "connection.sync_start_failed"],
    ["media_start_failed", "connection.media_start_failed"],
    ["sync_recovery_exhausted", "connection.sync_recovery_exhausted"],
    ["media_recovery_exhausted", "connection.media_recovery_exhausted"],
    ["internal_error", "client.internal_error"],
  ] as const)("preserves %s and recoverability", (code, publicCode) => {
    const store = new SpaceStore();
    for (const recoverable of [true, false]) {
      store.updateConnection({ state: "failed", subject: null, episode: null, connection: { sync: "failed", media: "failed" }, failure: { code, action: null, recoverable, message: "Startup failed" } });
      expect(store.getSnapshot().connection.lastError).toEqual({ code: publicCode, recoverable, message: "Startup failed" });
    }
  });
});
