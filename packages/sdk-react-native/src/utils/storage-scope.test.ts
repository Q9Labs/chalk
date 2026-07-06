import { describe, expect, it } from "vitest";

import { createStorageScopeId } from "./storage-scope";

describe("createStorageScopeId", () => {
  it("creates stable api/key scoped ids", () => {
    expect(createStorageScopeId("https://api.chalkmeet.com", "ck_test_1")).toBe(createStorageScopeId("https://api.chalkmeet.com", "ck_test_1"));
    expect(createStorageScopeId("https://api.chalkmeet.com", "ck_test_1")).not.toBe(createStorageScopeId("https://api.chalkmeet.com", "ck_test_2"));
  });
});
