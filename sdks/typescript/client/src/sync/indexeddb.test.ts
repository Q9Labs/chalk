import { describe, expect, it } from "vitest";
import { SyncBrowserCapabilityError, SyncPersistenceError } from "./index";
import { IndexedDbPendingCommandStore } from "./indexeddb";

describe("IndexedDbPendingCommandStore", () => {
  it("requires a nonempty scope and an IndexedDB capability", async () => {
    expect(() => new IndexedDbPendingCommandStore({ scope: "" })).toThrow(SyncPersistenceError);

    const store = new IndexedDbPendingCommandStore({ scope: "test", indexedDb: undefined });
    await expect(store.load()).rejects.toBeInstanceOf(SyncBrowserCapabilityError);
  });
});
