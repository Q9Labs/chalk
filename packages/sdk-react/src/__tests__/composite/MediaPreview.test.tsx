import { describe, it, expect, vi } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { MediaPreview } from "../../components/composite/MediaPreview";

// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
global.MediaStream = vi.fn().mockImplementation(() => ({})) as any;

describe("MediaPreview", () => {
  it("renders correctly", () => {
    const { getByLabelText } = render(<MediaPreview />);
    expect(getByLabelText("Mute")).toBeDefined();
    expect(getByLabelText("Stop Video")).toBeDefined();
  });

  it("calls onToggleAudio when mic button is clicked", () => {
    const onToggleAudio = vi.fn();
    const { getByLabelText } = render(<MediaPreview onToggleAudio={onToggleAudio} />);
    fireEvent.click(getByLabelText("Mute"));
    expect(onToggleAudio).toHaveBeenCalledTimes(1);
  });

  it("shows unmute when audio is disabled", () => {
    const { getByLabelText } = render(<MediaPreview isAudioEnabled={false} />);
    expect(getByLabelText("Unmute")).toBeDefined();
  });
});
