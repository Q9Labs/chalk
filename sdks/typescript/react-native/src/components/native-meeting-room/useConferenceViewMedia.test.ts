import { describe, expect, it, vi } from "vitest";

import { useConferenceViewMedia } from "./useConferenceViewMedia";

describe("useConferenceViewMedia", () => {
  it("projects local media state and routes controls through the action runner", () => {
    const run = vi.fn(async (action: () => unknown | Promise<unknown>) => {
      await action();
    });
    const toggleAudio = vi.fn(async () => true);
    const toggleVideo = vi.fn(async () => false);
    const toggleScreenShare = vi.fn(async () => true);

    const media = useConferenceViewMedia({
      media: { isAudioEnabled: false, isVideoEnabled: true, toggleAudio, toggleVideo },
      screenShare: { toggle: toggleScreenShare },
      run,
    });

    expect(media).toMatchObject({ isMuted: true, isCameraOff: false });
    media.toggleAudio();
    media.toggleVideo();
    media.toggleScreenShare();

    expect(toggleAudio).toHaveBeenCalledOnce();
    expect(toggleVideo).toHaveBeenCalledOnce();
    expect(toggleScreenShare).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
