import { describe, expect, it, vi } from "bun:test";
import { render } from "@testing-library/react";

import { PictureInPictureWindow } from "../../components/full/picture-in-picture/PictureInPictureWindow";

function participant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "participant" as const,
    title: id.toUpperCase(),
    subtitle: "Live",
    videoTrack: null,
    isMuted: false,
    isSpeaking: false,
    ...overrides,
  };
}

describe("PictureInPictureWindow", () => {
  it("renders a split layout for two participants", () => {
    const { getByTestId, getAllByTestId } = render(
      <PictureInPictureWindow
        phase="meeting"
        source={participant("a")}
        participantSources={[participant("a"), participant("b")]}
        meetingLayout="split"
        controls={{}}
        onReturnToTab={() => {}}
      />,
    );

    expect(getByTestId("pip-layout")).toHaveAttribute("data-layout", "split");
    expect(getAllByTestId("pip-tile")).toHaveLength(2);
  });

  it("renders an overflow tile in grid mode", () => {
    const { getByLabelText, getByTestId, getAllByTestId } = render(
      <PictureInPictureWindow
        phase="meeting"
        source={participant("a")}
        participantSources={[participant("a"), participant("b"), participant("c"), { id: "overflow:2", kind: "placeholder", title: "+2", subtitle: "more" }]}
        meetingLayout="grid"
        controls={{}}
        onReturnToTab={() => {}}
      />,
    );

    expect(getByTestId("pip-layout")).toHaveAttribute("data-layout", "grid");
    expect(getAllByTestId("pip-tile")).toHaveLength(4);
    expect(getByLabelText("PiP overflow +2")).toBeDefined();
  });

  it("renders a screen-share layout with side participants", () => {
    const { getByTestId, getAllByTestId } = render(
      <PictureInPictureWindow
        phase="meeting"
        source={{ id: "screen", kind: "screen-share", title: "Teacher", subtitle: "Screen sharing", videoTrack: null }}
        participantSources={[participant("a"), participant("b")]}
        meetingLayout="screen-share"
        controls={{}}
        onReturnToTab={() => {}}
      />,
    );

    expect(getByTestId("pip-layout")).toHaveAttribute("data-layout", "screen-share");
    expect(getAllByTestId("pip-tile")).toHaveLength(3);
  });

  it("avoids key warnings when participant sources reuse ids", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { getAllByTestId } = render(
      <PictureInPictureWindow
        phase="meeting"
        source={participant("teacher")}
        participantSources={[participant("dup"), participant("dup"), participant("teacher")]}
        meetingLayout="grid"
        controls={{}}
        onReturnToTab={() => {}}
      />,
    );

    expect(getAllByTestId("pip-tile")).toHaveLength(3);
    expect(consoleError.mock.calls.some(([message]) => String(message).includes('Each child in a list should have a unique "key" prop.'))).toBe(false);

    consoleError.mockRestore();
  });

  it("shows a join error in prejoin PiP", () => {
    const { getByText, getAllByText, queryByText } = render(
      <PictureInPictureWindow
        phase="prejoin"
        source={participant("a")}
        controls={{ errorMessage: "Failed to join room", supportCode: "CHK-123" }}
        onReturnToTab={() => {}}
      />,
    );

    expect(getByText("Unable to join room")).toBeDefined();
    expect(getAllByText("Failed to join room")).toHaveLength(2);
    expect(getByText("Technical details")).toBeDefined();
    expect(getByText("Support code")).toBeDefined();
    expect(getByText("CHK-123")).toBeDefined();
    expect(queryByText("You're not in the room yet")).toBeNull();
    expect(queryByText("Join Now")).toBeNull();
  });

  it("uses the local participant gradient preference for local PiP surfaces", () => {
    const localParticipantGradientPreference = { mode: "custom" as const, from: "#ff00aa", to: "#7c3aed" };
    const { container } = render(
      <PictureInPictureWindow
        phase="prejoin"
        source={participant("hasan", { isLocal: true })}
        controls={{ localParticipantGradientPreference }}
        onReturnToTab={() => {}}
      />,
    );

    expect(container.firstChild).toHaveStyle({
      "--primary": "#ff00aa",
    });
  });

  it("reuses device selector controls in prejoin PiP", () => {
    const { getByLabelText } = render(
      <PictureInPictureWindow
        phase="prejoin"
        source={participant("hasan")}
        controls={{
          isMuted: true,
          isVideoEnabled: false,
          audioInputDevices: [{ deviceId: "mic-1", kind: "audioinput", label: "Built-in Mic" }] as any,
          videoInputDevices: [{ deviceId: "cam-1", kind: "videoinput", label: "Front Camera" }] as any,
          selectedAudioInput: "mic-1",
          selectedVideoInput: "cam-1",
          onToggleMute: () => {},
          onToggleVideo: () => {},
          onAudioInputChange: () => {},
          onVideoInputChange: () => {},
          onJoin: () => {},
        }}
        onReturnToTab={() => {}}
      />,
    );

    expect(getByLabelText("Select microphone")).toBeDefined();
    expect(getByLabelText("Select camera")).toBeDefined();
    expect(getByLabelText("Unmute microphone")).toBeDefined();
    expect(getByLabelText("Turn on camera")).toBeDefined();
  });
});
