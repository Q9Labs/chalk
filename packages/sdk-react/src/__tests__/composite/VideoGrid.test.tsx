import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { VideoGrid } from "../../components/composite/VideoGrid";

// Mock play and MediaStream
// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
global.MediaStream = vi.fn().mockImplementation(() => ({})) as any;

describe("VideoGrid", () => {
  const participants = [
    { id: "1", displayName: "Alice" },
    { id: "2", displayName: "Bob" },
  ];

  it("renders participant tiles", () => {
    const { getByLabelText } = render(<VideoGrid participants={participants} />);
    expect(getByLabelText("Video tile for Alice")).toBeDefined();
    expect(getByLabelText("Video tile for Bob")).toBeDefined();
  });

  it("renders spotlight layout", () => {
    const { getByLabelText, container } = render(<VideoGrid participants={participants} layout="spotlight" />);
    expect(getByLabelText("Video tile for Alice")).toBeDefined();
    expect(getByLabelText("Video tile for Bob")).toBeDefined();
    expect(container.querySelector(".h-40")).toBeDefined();
  });

  it("prefers a remote participant in spotlight layout when the local participant is first", () => {
    const spotlightParticipants = [
      { id: "local", displayName: "Alina", isLocal: true },
      { id: "remote", displayName: "Muhammad", isLocal: false },
    ];

    const { container } = render(<VideoGrid participants={spotlightParticipants} layout="spotlight" />);
    const mainTile = container.querySelector(".flex-1 [aria-label^='Video tile for ']");

    expect(mainTile?.getAttribute("aria-label")).toBe("Video tile for Muhammad");
  });

  it("prefers a remote participant in sidebar layout when the local participant is first", () => {
    const sidebarParticipants = [
      { id: "local", displayName: "Alina", isLocal: true },
      { id: "remote", displayName: "Muhammad", isLocal: false },
    ];

    const { container } = render(<VideoGrid participants={sidebarParticipants} layout="sidebar" />);
    const mainTile = container.querySelector(".flex-1 [aria-label^='Video tile for ']");

    expect(mainTile?.getAttribute("aria-label")).toBe("Video tile for Muhammad");
  });

  it("shows overflow count when many participants", () => {
    const manyParticipants = Array.from({ length: 10 }, (_, i) => ({
      id: `${i}`,
      displayName: `User ${i}`,
    }));
    const { getByText } = render(<VideoGrid participants={manyParticipants} maxVisibleParticipants={4} />);
    expect(getByText("+6 more")).toBeDefined();
  });
});
