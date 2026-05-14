import { describe, expect, it } from "vitest";
import { createFriendlyRoomName, humanizeRoomName } from "../utils/friendly-room-name.ts";

describe("friendly-room-name", () => {
  it("creates a two-word intelligible room name", () => {
    const roomName = createFriendlyRoomName(() => 0);

    expect(roomName).toEqual({
      label: "Phantom Tea",
      slug: "phantom-tea",
    });
  });

  it("humanizes kebab names for display", () => {
    expect(humanizeRoomName("cable-delta")).toBe("Cable Delta");
  });

  it("keeps opaque ids untouched", () => {
    expect(humanizeRoomName("0a7c1c2b-84a6-4bb1-b0aa-57d5d878f4f1")).toBe("0a7c1c2b-84a6-4bb1-b0aa-57d5d878f4f1");
  });
});
