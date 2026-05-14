import { describe, expect, it } from "vitest";

import { getMeetingShareLink } from "../../components/full/meeting-room/MeetingRoomOverlays";

describe("getMeetingShareLink", () => {
  it("removes the autoJoin query param from the shared meeting link", () => {
    expect(getMeetingShareLink("https://chalk.com/room/abc?roomName=demo&autoJoin=true&utm_source=test")).toBe("https://chalk.com/room/abc?roomName=demo&utm_source=test");
  });

  it("preserves links that do not include autoJoin", () => {
    expect(getMeetingShareLink("https://chalk.com/room/abc?roomName=demo")).toBe("https://chalk.com/room/abc?roomName=demo");
  });
});
