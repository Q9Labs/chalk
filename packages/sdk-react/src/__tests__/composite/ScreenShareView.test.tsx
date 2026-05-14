import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ScreenShareView } from "../../components/composite/ScreenShareView";

// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
global.MediaStream = vi.fn().mockImplementation(() => ({})) as any;

describe("ScreenShareView", () => {
  const track = { kind: "video" } as MediaStreamTrack;
  const participants = [{ id: "1", displayName: "Alice" }];

  it("renders video element for share", () => {
    const { container, getByText } = render(<ScreenShareView screenShareTrack={track} sharedByName="John" participants={participants} />);
    expect(container.querySelector("video")).toBeDefined();
    expect(getByText("Shared by John")).toBeDefined();
  });

  it("calls onStopShare when button clicked", () => {
    const onStopShare = vi.fn();
    const { getByText } = render(<ScreenShareView screenShareTrack={track} sharedByName="John" participants={[]} onStopShare={onStopShare} />);
    fireEvent.click(getByText("Stop Sharing"));
    expect(onStopShare).toHaveBeenCalledTimes(1);
  });
});
