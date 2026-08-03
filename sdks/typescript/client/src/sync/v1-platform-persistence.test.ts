import { describe, expect, it } from "vitest";
import type { ReactNativeAsyncStorage } from "./react-native";
import { AsyncStorageV1PendingTargetStore, IndexedDbV1PendingTargetStore } from "./v1-platform-persistence";
import type { V1PendingTarget } from "./v1-types";

const storageKey = "chalk-sync-v1:pending-targets:tenant/session";

describe("platform v1 pending-target persistence", () => {
  it("isolates AsyncStorage scopes, validates restored targets, and removes empty namespaces", async () => {
    const storage = new MemoryAsyncStorage();
    const sessionStore = new AsyncStorageV1PendingTargetStore({ scope: "tenant/session", storage });
    const otherStore = new AsyncStorageV1PendingTargetStore({ scope: "tenant/other", storage });
    const target = pendingTarget();

    await sessionStore.put(target);
    expect(await otherStore.load()).toEqual([]);
    expect(await new AsyncStorageV1PendingTargetStore({ scope: "tenant/session", storage }).load()).toEqual([target]);

    storage.values.set(storageKey, JSON.stringify([target, { ...target, bytes: 0 }]));
    expect(await sessionStore.load()).toEqual([target]);

    await sessionStore.remove(target.commandId);
    expect(storage.values.has(storageKey)).toBe(false);
  });

  it("fails closed for invalid scopes, malformed storage, and unavailable IndexedDB", async () => {
    const storage = new MemoryAsyncStorage();
    expect(() => new AsyncStorageV1PendingTargetStore({ scope: "", storage })).toThrow("scope");
    expect(() => new IndexedDbV1PendingTargetStore({ scope: "", indexedDb: undefined })).toThrow("scope");

    storage.values.set(storageKey, "not-json");
    await expect(new AsyncStorageV1PendingTargetStore({ scope: "tenant/session", storage }).load()).rejects.toBeInstanceOf(SyntaxError);
    await expect(new IndexedDbV1PendingTargetStore({ scope: "tenant/session", indexedDb: undefined }).load()).rejects.toThrow("IndexedDB is unavailable");
  });
});

class MemoryAsyncStorage implements ReactNativeAsyncStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function pendingTarget(): V1PendingTarget {
  return {
    commandId: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4e21",
    createdAt: 1,
    bytes: 128,
    command: { name: "set_hand_raised", payload: { raised: true } },
  };
}
