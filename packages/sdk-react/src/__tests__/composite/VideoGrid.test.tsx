import { describe, it, expect, vi } from "bun:test";
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
    // In spotlight, one is main, others are in a bar
    expect(container.querySelector(".h-32")).toBeDefined();
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
