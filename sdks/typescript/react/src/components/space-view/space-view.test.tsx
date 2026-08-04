// @vitest-environment happy-dom

import type { ActiveReaction } from "@q9labsai/chalk-client";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceViewProps } from "./SpaceView";
import { SpaceView } from "./SpaceView";

const audioOutputSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));
const controlBarSpy = vi.hoisted(() =>
  vi.fn((props: { readonly buttons?: readonly string[]; readonly onLeft?: () => void; readonly onOpenReactions?: () => void }) => (
    <>
      <button type="button" onClick={props.onLeft}>
        Leave space
      </button>
      {props.buttons?.includes("reactions") ? (
        <button type="button" onClick={props.onOpenReactions}>
          Reactions
        </button>
      ) : null}
    </>
  )),
);
const participantGridSpy = vi.hoisted(() => vi.fn((props: { readonly layout: string }) => <div data-testid="participant-grid">{props.layout}</div>));
const screenShareSpy = vi.hoisted(() => vi.fn(() => <div data-testid="screen-share-view" />));
const whiteboardSpy = vi.hoisted(() => vi.fn(() => <div data-testid="whiteboard-view" />));

vi.mock("../audio-output/AudioOutput", () => ({ AudioOutput: audioOutputSpy }));
vi.mock("../control-bar/ControlBar", () => ({ ControlBar: controlBarSpy }));
vi.mock("../participant-grid/ParticipantGrid", () => ({ ParticipantGrid: participantGridSpy }));
vi.mock("../composite/ScreenShareView", () => ({ ScreenShareView: screenShareSpy }));
vi.mock("../whiteboard-view/WhiteboardView", () => ({ WhiteboardView: whiteboardSpy }));

beforeEach(() => {
  audioOutputSpy.mockClear();
  controlBarSpy.mockClear();
  participantGridSpy.mockClear();
  screenShareSpy.mockClear();
  whiteboardSpy.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SpaceView", () => {
  it("renders the approved active chrome from caller-owned props without a client provider", () => {
    const props = createProps({
      layout: "grid",
      participants: [participant("ada"), participant("grace")],
      audioParticipants: [{ id: "grace", audioTrack: { readyState: "live" } as MediaStreamTrack }],
      controls: { buttons: ["mic", "participants"] },
    });

    render(<SpaceView {...props} />);

    expect(screen.getByRole("main")).toHaveAttribute("data-chalk");
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByLabelText("Space stage")).toBeInTheDocument();
    expect(participantGridSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ layout: "grid", participants: props.participants }));
    expect(audioOutputSpy.mock.calls[0]?.[0]).toEqual({ participants: props.audioParticipants });
    expect(controlBarSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ placement: "floating", density: "comfortable", buttons: ["mic", "participants"] }));
  });

  it("renders one responsive panel and lets the panel close through its controlled callback", () => {
    const onPanelChange = vi.fn();
    render(
      <SpaceView
        {...createProps({
          panels: {
            active: "participants",
            onChange: onPanelChange,
            participants: { participants: [participant("ada")], searchable: false },
          },
        })}
      />,
    );

    expect(screen.getByRole("main")).toHaveAttribute("data-chalk");
    expect(screen.getByRole("complementary", { name: "Participants list" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onPanelChange).toHaveBeenCalledWith(null);
  });

  it("selects whiteboard and screen-share Stage content from props", () => {
    const screenShare = {
      screenShareTrack: { readyState: "live" } as MediaStreamTrack,
      sharedByName: "Grace",
    };
    const { rerender } = render(<SpaceView {...createProps({ layout: "presentation", screenShare })} />);

    expect(screenShareSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ sharedByName: "Grace" }));
    expect(participantGridSpy).not.toHaveBeenCalled();

    rerender(<SpaceView {...createProps({ layout: "focus", whiteboard: { isOpen: true, props: { canDraw: false } } })} />);
    expect(whiteboardSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ canDraw: false }));
  });

  it("keeps recovery over the active view and delegates leave to the caller", () => {
    const onLeft = vi.fn(() => Promise.resolve());
    render(
      <SpaceView
        {...createProps({
          onLeft,
          reconnecting: { isVisible: true, status: "reconnecting" },
        })}
      />,
    );

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Leave space" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(onLeft).toHaveBeenCalledOnce();
  });

  it("offers a separately confirmed End Episode action only when authorized by the caller", () => {
    const onEndEpisode = vi.fn();
    const view = render(<SpaceView {...createProps({ onLeft: vi.fn(), onEndEpisode })} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Leave space" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "End Episode for everyone" }));
    expect(onEndEpisode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "End Episode" }));
    expect(onEndEpisode).toHaveBeenCalledOnce();

    view.rerender(<SpaceView {...createProps({ onLeft: vi.fn() })} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Leave space" })[0]!);
    expect(screen.queryByRole("button", { name: "End Episode for everyone" })).not.toBeInTheDocument();
  });

  it("passes reactions through the overlay and picker callback", () => {
    const onSelect = vi.fn();
    const reaction: ActiveReaction = {
      eventId: "reaction-1",
      participantId: "grace",
      displayName: "Grace",
      reaction: "🎉",
      occurredAt: "2026-08-01T10:00:00.000Z",
      expiresAt: "2026-08-01T10:00:05.000Z",
    };
    render(
      <SpaceView
        {...createProps({
          controls: { buttons: ["reactions"] },
          reactions: { reactions: [reaction], allowedReactions: ["🎉"], onSelect },
        })}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Reactions" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "React with 🎉" }));
    expect(onSelect).toHaveBeenCalledWith("🎉");
    expect(screen.getByText("🎉")).toBeInTheDocument();
  });
});

function createProps(overrides: Partial<SpaceViewProps> = {}): SpaceViewProps {
  return {
    spaceName: "Design review",
    displayName: "Ada",
    participants: [participant("ada")],
    ...overrides,
  };
}

function participant(id: string) {
  return {
    id,
    displayName: id === "ada" ? "Ada" : "Grace",
    isLocal: id === "ada",
    isMuted: false,
    isVideoEnabled: true,
  };
}
