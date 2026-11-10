import { describe, expect, it } from "vitest";
import { directOrigin, directPathBlocked, directSyncUrl, markDirectPathFailed, type DirectPathMemory } from "./direct-path";

describe("directOrigin", () => {
  it("accepts a bare https origin", () => {
    expect(directOrigin("https://direct.example.test")?.origin).toBe("https://direct.example.test");
    expect(directOrigin("https://direct.example.test:8443/")?.host).toBe("direct.example.test:8443");
  });

  it.each(["http://direct.example.test", "https://direct.example.test/v1", "https://direct.example.test/?a=1", "https://user:pass@direct.example.test", "wss://direct.example.test", "direct.example.test", "", 3, null])("rejects %j", (value) => {
    expect(directOrigin(value)).toBeNull();
  });
});

it("derives the Sync URL on the same host", () => {
  const origin = directOrigin("https://direct.example.test");
  expect(origin && directSyncUrl(origin)).toBe("wss://direct.example.test/v1/sync");
});

describe("failure memory", () => {
  it("blocks a host until its memory ends and drops expired hosts on the next failure", () => {
    const memory: DirectPathMemory = new Map();
    markDirectPathFailed(memory, "a.example.test", 1_000, 500);
    expect(directPathBlocked(memory, "a.example.test", 1_499)).toBe(true);
    expect(directPathBlocked(memory, "a.example.test", 1_500)).toBe(false);

    markDirectPathFailed(memory, "b.example.test", 2_000, 500);

    expect([...memory.keys()]).toEqual(["b.example.test"]);
  });
});
