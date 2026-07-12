import { describe, expect, it } from "vitest";
import { SyncClient } from "./client";
import { createSyncClient } from "./create";
import { SyncCommandValidationError } from "./index";
import { InMemoryPendingCommandStore } from "./persistence";
import { syncV2ProtocolCodec } from "./v2-codec";
import { TestSockets } from "./__tests__/runtime";

describe("createSyncClient", () => {
  it("requires an explicit persistence scope unless the caller supplies a store", () => {
    const shared = {
      url: "ws://sync.test/v2/sync",
      token: async () => "token",
      codec: syncV2ProtocolCodec,
      webSocket: new TestSockets(),
      lifecycle: { subscribe: () => () => {} },
    };

    expect(() => createSyncClient(shared)).toThrow(SyncCommandValidationError);
    expect(createSyncClient({ ...shared, pendingStore: new InMemoryPendingCommandStore() })).toBeInstanceOf(SyncClient);
  });
});
