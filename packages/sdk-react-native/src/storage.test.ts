import { describe, expect, it, vi } from "vitest";

import { createSecureStoreTokenStorage } from "./storage";

describe("createSecureStoreTokenStorage", () => {
  it("namespaces token keys by api url and api key", async () => {
    const secureStore = {
      getItemAsync: vi.fn(async () => "stored-token"),
      setItemAsync: vi.fn(async () => undefined),
      deleteItemAsync: vi.fn(async () => undefined),
    };

    const storage = createSecureStoreTokenStorage("https://api.chalkmeet.com", "ck_test_1", secureStore);

    await expect(storage.get("access")).resolves.toBe("stored-token");
    await storage.set("refresh", "refresh-token");
    await storage.remove("access");

    const getKey = secureStore.getItemAsync.mock.calls[0]?.[0] ?? "";
    const setKey = secureStore.setItemAsync.mock.calls[0]?.[0] ?? "";
    const removeKey = secureStore.deleteItemAsync.mock.calls[0]?.[0] ?? "";

    expect(getKey).toMatch(/^chalk_mobile_host_token_v3_[a-z0-9]+_access$/u);
    expect(setKey).toBe(getKey.replace(/access$/u, "refresh"));
    expect(removeKey).toBe(getKey);
  });
});
