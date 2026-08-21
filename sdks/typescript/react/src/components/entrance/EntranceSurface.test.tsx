// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EntranceSurface, type EntranceSurfaceProps } from "./EntranceSurface";

afterEach(cleanup);

function surfaceProps(overrides: Partial<EntranceSurfaceProps> = {}): EntranceSurfaceProps {
  return {
    spaceName: "Design review",
    displayName: "",
    microphone: true,
    camera: true,
    joining: false,
    onDisplayNameChange: vi.fn(),
    onMicrophoneChange: vi.fn(),
    onCameraChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

describe("EntranceSurface", () => {
  it("renders labeled controls, reflects device state, and reports arrival actions", () => {
    const onDisplayNameChange = vi.fn();
    const onMicrophoneChange = vi.fn();
    const onCameraChange = vi.fn();
    const onSubmit = vi.fn();
    const props = surfaceProps({ logoUrl: "/chalk.svg", onDisplayNameChange, onMicrophoneChange, onCameraChange, onSubmit, microphone: false, camera: true });
    const view = render(<EntranceSurface {...props} />);

    expect(screen.getByRole("img", { name: "Chalk" })).toHaveAttribute("src", "/chalk.svg");
    expect(screen.getByText("Design review")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your name" })).toHaveAttribute("autocomplete", "name");
    expect(screen.getByRole("button", { name: "Microphone" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Camera" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Enter Space" })).toBeDisabled();
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-skin", "classic");
    expect(screen.getByRole("main").querySelector(":scope > section")).toHaveClass("grid", "max-w-5xl", "overflow-hidden", "rounded-lg", "border", "shadow-[var(--chalk-shadow)]");
    expect(screen.getByRole("region", { name: "Video tile for You" })).toBeInTheDocument();
    expect(view.container.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();

    const nameInput = screen.getByRole("textbox", { name: "Your name" });
    fireEvent.change(nameInput, { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Microphone" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera" }));
    fireEvent.keyDown(nameInput, { key: "Enter" });

    expect(onDisplayNameChange).toHaveBeenCalledWith("Ada");
    expect(onMicrophoneChange).toHaveBeenCalledWith(true);
    expect(onCameraChange).toHaveBeenCalledWith(false);
    expect(onSubmit).toHaveBeenCalledOnce();

    view.rerender(<EntranceSurface {...props} displayName="Ada" />);
    expect(screen.getByRole("button", { name: "Enter Space" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Enter Space" })).toHaveClass("bg-[var(--chalk-entrance-primary)]", "text-white", "hover:bg-[var(--chalk-entrance-primary-hover)]");
    fireEvent.click(screen.getByRole("button", { name: "Enter Space" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps the hand-drawn controls behind the chalk skin", () => {
    const view = render(<EntranceSurface {...surfaceProps({ theme: { skin: "chalk" } })} />);

    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-skin", "chalk");
    expect(screen.getByRole("button", { name: "Enter Space" })).toHaveClass("[--chalk-accent:var(--chalk-entrance-primary)]", "!text-white", "hover:[--chalk-accent:var(--chalk-entrance-primary-hover)]");
    expect(view.container.querySelector('[data-chalk-entrance-layout="split"] > div:last-child')).toHaveClass("grid", "lg:grid-cols-[minmax(0,1fr)_24rem]");
    expect(view.container.querySelectorAll("svg[data-chalk-chrome='true']").length).toBeGreaterThan(0);
  });

  it("switches renderer trees without changing hook order", () => {
    const props = surfaceProps({ displayName: "Ada" });
    const view = render(<EntranceSurface {...props} />);

    expect(view.container.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();

    view.rerender(<EntranceSurface {...props} theme={{ skin: "chalk" }} />);

    expect(view.container.querySelector("svg[data-chalk-chrome='true']")).toBeInTheDocument();
  });

  it("announces pending access and surfaces errors with an optional cancel action", () => {
    const onCancel = vi.fn();
    const view = render(<EntranceSurface {...surfaceProps({ displayName: "Ada", joining: true, error: "Access denied", previewError: "Preview unavailable", onCancel })} />);

    expect(screen.getByRole("heading", { name: "Requesting access" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Access request in progress");
    expect(screen.queryByRole("textbox", { name: "Your name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enter Space" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Access denied");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();

    view.rerender(<EntranceSurface {...surfaceProps({ displayName: "Ada", previewError: "Preview unavailable" })} />);
    expect(screen.getByRole("heading", { name: "Enter this Space" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Preview unavailable");
    expect(screen.getByRole("button", { name: "Enter Space" })).toBeEnabled();
  });

  it("disables device toggles while access is loading", () => {
    render(<EntranceSurface {...surfaceProps({ displayName: "Ada", joining: true })} />);

    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Microphone" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Camera" })).toBeDisabled();
  });

  it("places device selectors beside the preview and reports client selections", () => {
    const onAudioInputChange = vi.fn();
    const onVideoInputChange = vi.fn();
    const onAudioOutputChange = vi.fn();

    render(
      <EntranceSurface
        {...surfaceProps({
          displayName: "Ada",
          audioInputDevices: [{ deviceId: "mic-1", label: "Desk microphone" }],
          videoInputDevices: [{ deviceId: "camera-1", label: "Wide camera" }],
          audioOutputDevices: [{ deviceId: "speaker-1", label: "Headphones" }],
          selectedAudioInput: "mic-1",
          selectedVideoInput: "camera-1",
          selectedAudioOutput: "speaker-1",
          onAudioInputChange,
          onVideoInputChange,
          onAudioOutputChange,
        })}
      />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Microphone" }).querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Camera" }).querySelector("svg")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose microphone devices" }));
    expect(screen.getByRole("combobox", { name: "Microphone input" })).toHaveValue("mic-1");
    expect(screen.getByRole("combobox", { name: "Audio output" })).toHaveValue("speaker-1");
    fireEvent.change(screen.getByRole("combobox", { name: "Microphone input" }), { target: { value: "mic-1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Audio output" }), { target: { value: "speaker-1" } });

    fireEvent.click(screen.getByRole("button", { name: "Choose camera devices" }));
    expect(screen.getByRole("combobox", { name: "Camera input" })).toHaveValue("camera-1");
    fireEvent.change(screen.getByRole("combobox", { name: "Camera input" }), { target: { value: "camera-1" } });

    expect(onAudioInputChange).toHaveBeenCalledWith("mic-1");
    expect(onVideoInputChange).toHaveBeenCalledWith("camera-1");
    expect(onAudioOutputChange).toHaveBeenCalledWith("speaker-1");
  });

  it("shows a video preview only when camera is enabled and the stream has video tracks", () => {
    const videoTrack = {} as MediaStreamTrack;
    const previewStream = { getVideoTracks: () => [videoTrack] } as unknown as MediaStream;
    const props = surfaceProps({ previewStream, displayName: "Ada" });
    const originalSrcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, get: () => null, set: () => undefined });

    try {
      const view = render(<EntranceSurface {...props} />);
      const video = view.container.querySelector("video");

      expect(video).toBeInTheDocument();
      expect(video).not.toHaveClass("hidden");
      expect(screen.queryByRole("region", { name: "Video tile for Ada" })).not.toBeInTheDocument();

      view.rerender(<EntranceSurface {...props} camera={false} />);
      expect(video).toHaveClass("hidden");
      expect(screen.getByRole("region", { name: "Video tile for Ada" })).toBeInTheDocument();
      view.unmount();
    } finally {
      if (originalSrcObject) Object.defineProperty(HTMLMediaElement.prototype, "srcObject", originalSrcObject);
      else delete (HTMLMediaElement.prototype as { srcObject?: unknown }).srcObject;
    }
  });
});
