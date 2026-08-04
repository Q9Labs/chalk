import { describe, expect, it } from "vitest";
import { createSpaceClient } from "./space-client";

describe("Promise SpaceClient entry", () => {
  it("exposes the five controllers", () => {
    const client = createSpaceClient({
      space: "demo",
      getAccess: async () => {
        throw new Error("not joined");
      },
    });
    expect(Object.keys(client).filter((key) => ["media", "chat", "participants", "reactions", "whiteboard"].includes(key))).toHaveLength(5);
    client.dispose();
  });
});
