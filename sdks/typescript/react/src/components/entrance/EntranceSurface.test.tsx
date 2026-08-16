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
    expect(screen.getByRole("button", { name: /Microphone/u })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Camera/u })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Enter Space" })).toBeDisabled();

    const nameInput = screen.getByRole("textbox", { name: "Your name" });
    fireEvent.change(nameInput, { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: /Microphone/u }));
    fireEvent.click(screen.getByRole("button", { name: /Camera/u }));
    fireEvent.keyDown(nameInput, { key: "Enter" });

    expect(onDisplayNameChange).toHaveBeenCalledWith("Ada");
    expect(onMicrophoneChange).toHaveBeenCalledWith(true);
    expect(onCameraChange).toHaveBeenCalledWith(false);
    expect(onSubmit).toHaveBeenCalledOnce();

    view.rerender(<EntranceSurface {...props} displayName="Ada" />);
    expect(screen.getByRole("button", { name: "Enter Space" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Enter Space" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
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
    expect(screen.getByRole("button", { name: /Microphone/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Camera/u })).toBeDisabled();
  });

  it("shows a video preview only when camera is enabled and the stream has video tracks", () => {
    const videoTrack = {} as MediaStreamTrack;
    const previewStream = { getVideoTracks: () => [videoTrack] } as unknown as MediaStream;
    const props = surfaceProps({ previewStream });
    const originalSrcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, get: () => null, set: () => undefined });

    try {
      const view = render(<EntranceSurface {...props} />);
      const video = view.container.querySelector("video");

      expect(video).toBeInTheDocument();
      expect(video).not.toHaveClass("hidden");
      expect(screen.queryByText("Camera preview")).not.toBeInTheDocument();

      view.rerender(<EntranceSurface {...props} camera={false} />);
      expect(video).toHaveClass("hidden");
      expect(screen.getByText("Camera preview")).toBeInTheDocument();
      view.unmount();
    } finally {
      if (originalSrcObject) Object.defineProperty(HTMLMediaElement.prototype, "srcObject", originalSrcObject);
      else delete (HTMLMediaElement.prototype as { srcObject?: unknown }).srcObject;
    }
  });
});
