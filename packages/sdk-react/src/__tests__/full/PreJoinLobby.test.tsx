import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { PreJoinLobby } from "../../components/full/PreJoinLobby";
import { SharedPictureInPictureProvider } from "../../components/full/picture-in-picture/PictureInPictureContext";

// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
global.MediaStream = vi.fn(function (tracks: MediaStreamTrack[] = []) {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
    getAudioTracks: () => [],
  };
}) as any;
const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
const originalDocumentPictureInPicture = window.documentPictureInPicture;

describe("PreJoinLobby", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-chalk-theme");
    document.body.className = "";
    document.body.removeAttribute("data-theme");
    document.body.removeAttribute("data-chalk-theme");
    window.documentPictureInPicture = originalDocumentPictureInPicture;
  });

  it("renders correctly", async () => {
    const { getByText, getByPlaceholderText } = render(<PreJoinLobby onJoin={() => {}} roomName="Big Meeting" initialVideoEnabled={false} initialAudioEnabled={false} />);
    await act(async () => {});
    expect(getByText("Big Meeting")).toBeDefined();
    expect(getByPlaceholderText("Enter your name")).toBeDefined();
    expect(getByText("Ask to join")).toBeDefined();
  });

  it("clamps the pre-join brand mark so large custom logos do not dominate the layout", async () => {
    const { getByAltText } = render(<PreJoinLobby onJoin={() => {}} roomName="Big Meeting" initialVideoEnabled={false} initialAudioEnabled={false} />);
    await act(async () => {});

    const logo = getByAltText("Chalk") as HTMLImageElement;
    expect(logo.style.maxWidth).toBe("clamp(140px, 24vw, 240px)");
    expect(logo.style.maxHeight).toBe("clamp(56px, 12vh, 120px)");
  });

  it("starts with camera and microphone off by default", async () => {
    const { getByLabelText } = render(<PreJoinLobby onJoin={() => {}} roomName="Big Meeting" />);
    await act(async () => {});

    const audioButton = getByLabelText("Unmute microphone");
    const videoButton = getByLabelText("Turn on camera");

    expect(audioButton).toBeDefined();
    expect(videoButton).toBeDefined();
    expect(audioButton.className).toContain("h-9");
    expect(videoButton.className).toContain("h-9");
  });

  it("renders with shared picture-in-picture enabled without re-render loops", async () => {
    const { getByText } = render(
      <SharedPictureInPictureProvider enabled>
        <PreJoinLobby onJoin={() => {}} roomName="Big Meeting" initialVideoEnabled={false} initialAudioEnabled={false} enablePictureInPicture />
      </SharedPictureInPictureProvider>,
    );

    await act(async () => {});
    expect(getByText("Big Meeting")).toBeDefined();
  });

  it("labels camera and microphone selector controls", async () => {
    const devices = [
      { deviceId: "device-1", kind: "videoinput", label: "Camera 1", groupId: "group-1", toJSON: () => ({}) },
      { deviceId: "device-2", kind: "audioinput", label: "Mic 1", groupId: "group-2", toJSON: () => ({}) },
    ] as MediaDeviceInfo[];

    const { getByLabelText } = render(<PreJoinLobby onJoin={() => {}} initialVideoEnabled={false} initialAudioEnabled={false} videoDevices={[devices[0] as MediaDeviceInfo]} audioInputDevices={[devices[1] as MediaDeviceInfo]} />);
    await act(async () => {});

    expect(getByLabelText("Select camera")).toBeDefined();
    expect(getByLabelText("Select microphone")).toBeDefined();
  });

  it("calls onJoin with settings when join button is clicked", async () => {
    const onJoin = vi.fn();
    const { getByPlaceholderText, getByText } = render(<PreJoinLobby onJoin={onJoin} userName="John Doe" initialVideoEnabled={false} initialAudioEnabled={false} />);
    await act(async () => {});

    const input = getByPlaceholderText("Enter your name");
    expect((input as HTMLInputElement).value).toBe("John Doe");
    await act(async () => {
      fireEvent.click(getByText("Ask to join"));
    });
    expect(onJoin).toHaveBeenCalled();
    expect(onJoin.mock.calls[0][0].displayName).toBe("John Doe");
  });

  it("applies mic toggle state when joining from pre-join controls", async () => {
    const onJoin = vi.fn();
    const { getByLabelText, getByText } = render(<PreJoinLobby onJoin={onJoin} userName="John Doe" initialVideoEnabled={false} initialAudioEnabled={true} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(getByLabelText("Mute microphone"));
    });
    await act(async () => {
      fireEvent.click(getByText("Ask to join"));
    });

    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin.mock.calls[0][0].audioEnabled).toBe(false);
  });

  it("trims display name before calling onJoin", async () => {
    const onJoin = vi.fn();
    const { getByText } = render(<PreJoinLobby onJoin={onJoin} userName="  Hasan  " initialVideoEnabled={false} initialAudioEnabled={false} />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(getByText("Ask to join"));
    });

    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin.mock.calls[0][0].displayName).toBe("Hasan");
  });

  it("allows clearing the default Chalker name", async () => {
    const { getByPlaceholderText } = render(<PreJoinLobby onJoin={() => {}} initialVideoEnabled={false} initialAudioEnabled={false} />);
    await act(async () => {});

    const input = getByPlaceholderText("Enter your name") as HTMLInputElement;
    expect(input.value).toBe("Chalker");

    await act(async () => {
      fireEvent.change(input, { target: { value: "" } });
    });
    await act(async () => {});
    expect(input.value).toBe("");

    await act(async () => {
      fireEvent.change(input, { target: { value: "Hasan" } });
    });
    await act(async () => {});
    expect(input.value).toBe("Hasan");
  });

  it("shows diagnostic error sheet when error prop is provided", async () => {
    const { getByText } = render(<PreJoinLobby onJoin={() => {}} error="Failed to get camera" supportCode="CHK-20260302-101010-001" initialVideoEnabled={false} initialAudioEnabled={false} />);
    await act(async () => {});
    expect(getByText("Just a small bump in the road")).toBeDefined();
    expect(getByText("Support Code")).toBeDefined();
    expect(getByText("CHK-20260302-101010-001")).toBeDefined();
    expect(getByText("Failed to get camera")).toBeDefined();
  });

  it("does not reacquire local video stream after local track state updates", async () => {
    const firstTrack = { stop: vi.fn() };
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [firstTrack],
      getVideoTracks: () => [firstTrack],
      getAudioTracks: () => [],
    });
    navigator.mediaDevices.getUserMedia = getUserMedia as any;

    render(<PreJoinLobby onJoin={() => {}} initialVideoEnabled initialAudioEnabled={false} />);

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("stops previous local video track when camera selection changes", async () => {
    const firstTrack = { stop: vi.fn() };
    const secondTrack = { stop: vi.fn() };
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce({
        getTracks: () => [firstTrack],
        getVideoTracks: () => [firstTrack],
        getAudioTracks: () => [],
      })
      .mockResolvedValueOnce({
        getTracks: () => [secondTrack],
        getVideoTracks: () => [secondTrack],
        getAudioTracks: () => [],
      });
    navigator.mediaDevices.getUserMedia = getUserMedia as any;

    const { rerender } = render(<PreJoinLobby onJoin={() => {}} initialVideoEnabled initialAudioEnabled={false} selectedVideoDevice="camera-1" />);

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    rerender(<PreJoinLobby onJoin={() => {}} initialVideoEnabled initialAudioEnabled={false} selectedVideoDevice="camera-2" />);

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });
    expect(firstTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps camera enabled when a stale preferred camera id fails on first mobile request", async () => {
    const fallbackTrack = { stop: vi.fn() };
    const getUserMedia = vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
      const videoConstraint = constraints.video;
      if (typeof videoConstraint === "object" && videoConstraint && "deviceId" in videoConstraint) {
        return Promise.reject(new DOMException("stale camera", "OverconstrainedError"));
      }

      return Promise.resolve({
        getTracks: () => [fallbackTrack],
        getVideoTracks: () => [fallbackTrack],
        getAudioTracks: () => [],
      });
    });
    navigator.mediaDevices.getUserMedia = getUserMedia as any;

    const { getByLabelText } = render(<PreJoinLobby onJoin={() => {}} initialVideoEnabled={false} initialAudioEnabled={false} selectedVideoDevice="stale-camera" />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(getByLabelText("Turn on camera"));
    });

    await waitFor(() => {
      expect(getByLabelText("Turn off camera")).toBeDefined();
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "stale-camera" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
    });
  });

  it("shows picture in picture control when supported and enabled", async () => {
    window.documentPictureInPicture = {
      requestWindow: vi.fn(),
    } as any;

    const { getByLabelText } = render(<PreJoinLobby onJoin={() => {}} enablePictureInPicture={true} initialVideoEnabled={false} initialAudioEnabled={false} />);

    await act(async () => {});
    expect(getByLabelText("Open picture in picture")).toBeDefined();
  });

  it("resolves theme from data-chalk-theme before data-theme and class", async () => {
    document.documentElement.classList.add("light");
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("data-chalk-theme", "dark");

    const { getByRole } = render(<PreJoinLobby onJoin={() => {}} initialVideoEnabled={false} initialAudioEnabled={false} initialTheme="light" />);
    await act(async () => {});

    expect(getByRole("button", { name: "Switch to light mode" })).toBeDefined();
  });

  it("syncs toggle label when external theme attributes change", async () => {
    const { getByRole } = render(<PreJoinLobby onJoin={() => {}} initialVideoEnabled={false} initialAudioEnabled={false} initialTheme="light" />);
    await act(async () => {});

    expect(getByRole("button", { name: "Switch to dark mode" })).toBeDefined();

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
    });

    await waitFor(() => {
      expect(getByRole("button", { name: "Switch to light mode" })).toBeDefined();
    });
  });

  it("updates icon label and active theme when toggled", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const { getByRole } = render(<PreJoinLobby onJoin={() => {}} initialVideoEnabled={false} initialAudioEnabled={false} />);
    await act(async () => {});

    const themeButton = getByRole("button", { name: "Switch to light mode" });
    await act(async () => {
      fireEvent.click(themeButton);
    });

    await waitFor(() => {
      expect(getByRole("button", { name: "Switch to dark mode" })).toBeDefined();
    });
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("renders picture-in-picture settings in settings modal", async () => {
    window.documentPictureInPicture = {
      requestWindow: vi.fn(),
    } as any;

    const { getByLabelText, getByRole, getByText } = render(<PreJoinLobby onJoin={() => {}} enablePictureInPicture={true} initialVideoEnabled={false} initialAudioEnabled={false} />);
    await act(async () => {});

    fireEvent.click(getByLabelText("Settings"));
    fireEvent.click(getByText("Experience"));

    expect(getByRole("switch", { name: "Auto-open Picture-in-Picture" })).toBeDefined();
    expect(getByRole("button", { name: "Open Picture-in-Picture now" })).toBeDefined();
  });
});
