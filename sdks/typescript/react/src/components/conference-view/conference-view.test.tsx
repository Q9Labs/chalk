// @vitest-environment happy-dom

import type { ActiveReaction } from "../../client-compat";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConferenceViewProps } from "./ConferenceView";
import { ConferenceView } from "./ConferenceView";

const audioOutputSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));
const controlBarSpy = vi.hoisted(() =>
  vi.fn((props: { readonly buttons?: readonly string[]; readonly onLeave?: () => void; readonly onOpenReactions?: () => void }) => (
    <>
      <button type="button" onClick={props.onLeave}>
        Leave meeting
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

describe("ConferenceView", () => {
  it("renders the approved active chrome from caller-owned props without a session provider", () => {
    const props = createProps({
      layout: "grid",
      participants: [participant("ada"), participant("grace")],
      audioParticipants: [{ id: "grace", audioTrack: { readyState: "live" } as MediaStreamTrack }],
      controls: { buttons: ["mic", "participants"] },
    });

    render(<ConferenceView {...props} />);

    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-theme", "light");
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-palette", "light");
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-texture", "none");
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByLabelText("Meeting stage")).toBeInTheDocument();
    expect(participantGridSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ layout: "grid", participants: props.participants }));
    expect(audioOutputSpy.mock.calls[0]?.[0]).toEqual({ participants: props.audioParticipants });
    expect(controlBarSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ placement: "floating", density: "comfortable", buttons: ["mic", "participants"] }));
  });

  it("renders one responsive panel and lets the panel close through its controlled callback", () => {
    const onPanelChange = vi.fn();
    render(
      <ConferenceView
        {...createProps({
          panels: {
            active: "participants",
            onChange: onPanelChange,
            participants: { participants: [participant("ada")], searchable: false },
          },
          palette: "oled-signal",
          texture: "paper",
        })}
      />,
    );

    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-theme", "dark");
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-palette", "oled-signal");
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-texture", "paper");
    expect(screen.getByRole("complementary", { name: "Participants list" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onPanelChange).toHaveBeenCalledWith(null);
  });

  it("selects whiteboard and screen-share Stage content from props", () => {
    const screenShare = {
      screenShareTrack: { readyState: "live" } as MediaStreamTrack,
      sharedByName: "Grace",
    };
    const { rerender } = render(<ConferenceView {...createProps({ layout: "presentation", screenShare })} />);

    expect(screenShareSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ sharedByName: "Grace" }));
    expect(participantGridSpy).not.toHaveBeenCalled();

    rerender(<ConferenceView {...createProps({ layout: "focus", whiteboard: { isOpen: true, props: { canDraw: false } } })} />);
    expect(whiteboardSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ canDraw: false }));
  });

  it("keeps recovery over the active view and delegates leave to the caller", () => {
    const onLeave = vi.fn(() => Promise.resolve());
    render(
      <ConferenceView
        {...createProps({
          onLeave,
          reconnecting: { isVisible: true, status: "reconnecting" },
        })}
      />,
    );

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Leave meeting" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(onLeave).toHaveBeenCalledOnce();
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
      <ConferenceView
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

function createProps(overrides: Partial<ConferenceViewProps> = {}): ConferenceViewProps {
  return {
    roomName: "Design review",
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
