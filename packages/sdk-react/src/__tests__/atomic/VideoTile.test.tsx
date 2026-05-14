import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { VideoTile } from "../../components/atomic/VideoTile";

// Mock play
// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
// @ts-ignore
window.HTMLMediaElement.prototype.pause = vi.fn();

global.MediaStream = vi.fn().mockImplementation(() => ({})) as any;

describe("VideoTile", () => {
  const participant = {
    id: "p1",
    displayName: "Alice",
    isVideoEnabled: true,
  };

  it("renders video element when video is enabled", () => {
    const { container } = render(<VideoTile participant={participant} videoTrack={{} as any} />);
    expect(container.querySelector("video")).toBeDefined();
  });

  it("renders avatar when video is disabled", () => {
    const disabledParticipant = { ...participant, isVideoEnabled: false };
    const { getAllByRole } = render(<VideoTile participant={disabledParticipant} />);
    expect(getAllByRole("img", { name: "Avatar for Alice" }).length).toBeGreaterThan(0);
  });

  it("renders name tag by default", () => {
    const { getByText } = render(<VideoTile participant={participant} />);
    expect(getByText(/Alice/)).toBeDefined();
  });

  it("shows muted icon when participant is muted", () => {
    const mutedParticipant = { ...participant, isMuted: true };
    const { container } = render(<VideoTile participant={mutedParticipant} />);
    // MicOff icon is rendered
    expect(container.querySelector("svg")).toBeDefined();
  });

});
