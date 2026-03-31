import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { HotkeyManager } from "@tanstack/react-hotkeys";
import { MeetingRoom } from "../../components/full/MeetingRoom";
import { SharedPictureInPictureProvider } from "../../components/full/picture-in-picture/PictureInPictureContext";

vi.mock("../../components/composite/ParticipantList/ParticipantOptionsMenu", () => ({
  ParticipantOptionsMenu: () => null,
}));

vi.mock("../../components/full/WhiteboardPanel", () => ({
  WhiteboardPanel: () => <div aria-label="Whiteboard panel" />,
}));

// Mock everything
// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
// @ts-ignore
window.HTMLElement.prototype.scrollIntoView = vi.fn();
global.MediaStream = vi.fn().mockImplementation(() => ({})) as any;
global.MediaStreamTrack = vi.fn().mockImplementation(() => ({
  kind: "video",
  enabled: true,
  stop: vi.fn(),
})) as any;
const originalDocumentPictureInPicture = window.documentPictureInPicture;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
const setNavigatorPlatform = (platform: string, userAgent: string) => {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
};

describe("MeetingRoom", () => {
  const vibrateSpy = vi.spyOn(navigator, "vibrate");

  beforeEach(() => {
    localStorage.clear();
    vibrateSpy.mockClear();
    window.documentPictureInPicture = originalDocumentPictureInPicture;
    window.requestAnimationFrame = originalRequestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0)) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame ?? ((handle: number) => window.clearTimeout(handle)) as typeof window.cancelAnimationFrame;
    HotkeyManager.resetInstance();
    setNavigatorPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  });

  afterAll(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  const localParticipant = {
    id: "local",
    displayName: "Me",
    isLocal: true,
  };

  const participants = [{ id: "p1", displayName: "Alice" }];

  it("renders correctly", () => {
    const { getByText, getByLabelText } = render(<MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} />);
    expect(getByText("Test Room")).toBeDefined();
    expect(getByLabelText("Meeting controls")).toBeDefined();
  });

  it("renders with shared picture-in-picture enabled without re-render loops", () => {
    const { getByText } = render(
      <SharedPictureInPictureProvider enabled>
        <MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} enablePictureInPicture />
      </SharedPictureInPictureProvider>,
    );

    expect(getByText("Test Room")).toBeDefined();
  });

  it("hides the local share preview in the main stage to prevent mirror loops", () => {
    const localScreenSharer = {
      ...localParticipant,
      isScreenSharing: true,
      screenShareTrack: { kind: "video", readyState: "live" } as MediaStreamTrack,
    };

    const { getByText, queryByText } = render(
      <MeetingRoom
        roomName="Test Room"
        localParticipant={localScreenSharer}
        participants={[localScreenSharer, { id: "p1", displayName: "Alice" }]}
        enableTour={false}
      />,
    );

    expect(getByText("Preview hidden in this window")).toBeDefined();
    expect(queryByText("Shared by Me")).toBeNull();
  });

  it("shows chat panel when defaultChatOpen is true", () => {
    const { getByLabelText } = render(<MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={[]} defaultChatOpen={true} />);
    expect(getByLabelText("Chat panel")).toBeDefined();
  });

  it("dispatches a resize after opening chat with whiteboard already open", async () => {
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");

    try {
      const { getByRole, getByLabelText } = render(
        <MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} enableTour={false} enableWhiteboard={true} isWhiteboardOpen={true} />,
      );

      dispatchEventSpy.mockClear();

      fireEvent.click(getByRole("button", { name: "Chat" }));

      await waitFor(() => {
        expect(getByLabelText("Chat panel")).toBeDefined();
        expect(dispatchEventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "resize" }));
      });
    } finally {
      dispatchEventSpy.mockRestore();
    }
  });

  it("keeps mobile mute control clickable when invite toast is visible", () => {
    const onToggleMute = vi.fn();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })) as any;

    try {
      const { getByLabelText, getByRole } = render(<MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} enableTour={false} onToggleMute={onToggleMute} />);

      fireEvent.click(getByLabelText("Mute"));
      expect(onToggleMute).toHaveBeenCalledTimes(1);

      const inviteToast = getByRole("status");
      expect(inviteToast.className).toContain("top-4");
      expect(inviteToast.className).toContain("bottom-auto");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("fires haptics for mute keyboard shortcuts", () => {
    const onToggleMute = vi.fn();

    render(<MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} enableTour={false} onToggleMute={onToggleMute} />);

    fireEvent.keyDown(document, { key: "m" });

    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(vibrateSpy).toHaveBeenCalled();
  });

  it("fires haptics for video keyboard shortcuts", () => {
    const onToggleVideo = vi.fn();

    render(<MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} enableTour={false} onToggleVideo={onToggleVideo} />);

    fireEvent.keyDown(document, { key: "v" });

    expect(onToggleVideo).toHaveBeenCalledTimes(1);
    expect(vibrateSpy).toHaveBeenCalled();
  });

  it("opens settings with cmd+k", async () => {
    setNavigatorPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    const { getByRole } = render(<MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} enableTour={false} />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    await waitFor(() => {
      expect(getByRole("dialog", { name: "Meeting settings" })).toBeDefined();
    });
  });

  it("opens settings with ctrl+k", async () => {
    const { getByRole } = render(<MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} enableTour={false} />);

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    await waitFor(() => {
      expect(getByRole("dialog", { name: "Meeting settings" })).toBeDefined();
    });
  });

  it("does not open settings from editable inputs", () => {
    const { queryByRole } = render(
      <>
        <input aria-label="Outside input" />
        <MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} enableTour={false} />
      </>,
    );

    const input = document.querySelector('input[aria-label="Outside input"]') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });

    expect(queryByRole("dialog", { name: "Meeting settings" })).toBeNull();
  });

  it("shows support code in connection overlay", () => {
    const { getByText } = render(<MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} connectionState="failed" connectionSupportCode="CHK-20260302-121212-001" />);

    expect(getByText("Support Code")).toBeDefined();
    expect(getByText("CHK-20260302-121212-001")).toBeDefined();
  });

  it("renders inline device selectors in the desktop dock", () => {
    const { container, getByText } = render(
      <MeetingRoom
        roomName="Test Room"
        localParticipant={localParticipant}
        participants={participants}
        enableTour={false}
        audioInputDevices={[{ deviceId: "mic-1", kind: "audioinput", label: "Microphone 1" }]}
        audioOutputDevices={[{ deviceId: "spk-1", kind: "audiooutput", label: "Speaker 1" }]}
        videoInputDevices={[{ deviceId: "cam-1", kind: "videoinput", label: "Camera 1" }]}
        selectedAudioInput="mic-1"
        selectedAudioOutput="spk-1"
        selectedVideoInput="cam-1"
        onAudioInputChange={() => {}}
        onAudioOutputChange={() => {}}
        onVideoInputChange={() => {}}
      />,
    );

    const deviceMenuButtons = container.querySelectorAll('button[aria-haspopup="true"]');
    fireEvent.click(deviceMenuButtons[0] as HTMLButtonElement);
    expect(getByText("Microphone 1")).toBeDefined();
    expect(getByText("Speaker 1")).toBeDefined();

    fireEvent.click(deviceMenuButtons[1] as HTMLButtonElement);
    expect(getByText("Camera 1")).toBeDefined();
  });

  it("opens the settings dialog and changes microphone preference", () => {
    const onAudioInputChange = vi.fn();
    const { getByLabelText, getByRole, getByText } = render(
      <MeetingRoom
        roomName="Test Room"
        localParticipant={localParticipant}
        participants={participants}
        enableTour={false}
        audioInputDevices={[
          { deviceId: "mic-1", kind: "audioinput", label: "Microphone 1" },
          { deviceId: "mic-2", kind: "audioinput", label: "Microphone 2" },
        ]}
        audioOutputDevices={[
          { deviceId: "spk-1", kind: "audiooutput", label: "Speaker 1" },
          { deviceId: "spk-2", kind: "audiooutput", label: "Speaker 2" },
        ]}
        videoInputDevices={[
          { deviceId: "cam-1", kind: "videoinput", label: "Camera 1" },
          { deviceId: "cam-2", kind: "videoinput", label: "Camera 2" },
        ]}
        selectedAudioInput="mic-1"
        onAudioInputChange={onAudioInputChange}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Settings" }));
    const dialog = getByRole("dialog", { name: "Meeting settings" });
    expect(getByLabelText("Search settings")).toBeDefined();
    fireEvent.click(within(dialog).getByText("Microphone 1"));
    fireEvent.click(within(dialog).getByText("Microphone 2"));
    expect(onAudioInputChange).toHaveBeenCalledWith("mic-2");
  });

  it("applies and persists background effect selections", async () => {
    const onApplyBackgroundEffect = vi.fn();
    const { getByRole, getByText } = render(<MeetingRoom roomName="Test Room" localParticipant={localParticipant} participants={participants} enableTour={false} enableBackgroundEffects isBackgroundEffectsSupported onApplyBackgroundEffect={onApplyBackgroundEffect} />);

    fireEvent.click(getByRole("button", { name: "Settings" }));
    fireEvent.click(getByText("Video"));
    fireEvent.click(getByRole("button", { name: "Select Blur" }));

    await waitFor(() => {
      expect(onApplyBackgroundEffect).toHaveBeenCalledWith({ mode: "blur", blurStrength: undefined });
    });

    const stored = JSON.parse(localStorage.getItem("chalk-meeting-settings") ?? "{}");
    expect(stored.video.backgroundEffect).toEqual({ type: "blur" });
  });
});
