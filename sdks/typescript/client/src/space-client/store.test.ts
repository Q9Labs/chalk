import { describe, expect, it } from "vitest";

import type { ConnectionLifecycleSnapshot } from "../connection";
import { SpaceStore } from "./store";

describe("SpaceStore connection notice", () => {
  it("shows reconnecting while live Sync reconnects and clears it when Sync returns", () => {
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

    store.updateConnection(live);
    expect(store.getSnapshot().connection.status).toBe("live");
  });

  it("does not turn initial Join into a reconnecting notice", () => {
    const store = new SpaceStore();
    store.updateConnection({ state: "joining", subject: null, episode: null, connection: { sync: "connecting", media: "connecting" }, failure: null });
    expect(store.getSnapshot().connection.status).toBe("joining");
  });
});
