// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREVIEW_SEARCH, type PreviewSearch } from "./preview-state";

vi.mock("./PreviewGalleryToolbar", () => ({
  PreviewGalleryToolbar: ({ search, onChange }: { readonly search: PreviewSearch; readonly onChange: (patch: Partial<PreviewSearch>) => void }) => (
    <button type="button" data-testid="preview-toolbar" onClick={() => onChange({ hand: !search.hand })}>
      Preview controls
    </button>
  ),
}));

vi.mock("@q9labsai/chalk-react/components", () => {
  const MockPreJoinScreen = ({ error, onJoin }: { readonly error?: string; readonly onJoin: (settings: { displayName: string; microphoneEnabled: boolean; cameraEnabled: boolean }) => void }) => (
    <section data-testid="prejoin-screen">
      <h1>Entrance</h1>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={() => onJoin({ displayName: "Ada", microphoneEnabled: true, cameraEnabled: true })}>
        Enter Space
      </button>
    </section>
  );
  const MockJoiningScreen = ({ message }: { readonly message?: string }) => <div data-testid="joining-screen">{message}</div>;
  const MockJoinFailedScreen = ({ title, message, onRetry, onBack }: { readonly title?: string; readonly message: string; readonly onRetry: () => void; readonly onBack: () => void }) => (
    <section data-testid="join-failed-screen">
      <h1>{title}</h1>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
      <button type="button" onClick={onBack}>
        Back to Entrance
      </button>
    </section>
  );
  const MockEndScreen = ({ roomName }: { readonly roomName?: string }) => <section data-testid="end-screen">{roomName}</section>;
  const MockLeaveDialog = ({ isOpen, onClose, onConfirm }: { readonly isOpen: boolean; readonly onClose: () => void; readonly onConfirm: () => void }) =>
    isOpen ? (
      <section role="dialog" aria-label="Leave Space">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          Leave
        </button>
      </section>
    ) : null;
  const MockCommandErrorAlert = ({ message }: { readonly message?: string }) => (message ? <p role="alert">{message}</p> : null);
  const MockSpaceView = (props: {
    readonly participants: readonly unknown[];
    readonly panels?: { readonly active: string | null; readonly chat?: { readonly messages: readonly unknown[]; readonly pendingMessages?: readonly unknown[] }; readonly transcript?: { readonly transcripts: readonly unknown[] } };
    readonly controls?: { readonly onToggleHandRaise?: () => void };
    readonly overlay?: React.ReactNode;
    readonly reconnecting?: { readonly status: string };
    readonly onLeave?: () => void;
  }) => (
    <main data-testid="space-view">
      <output data-testid="participant-count">{props.participants.length}</output>
      <output data-testid="active-panel">{props.panels?.active ?? "none"}</output>
      <output data-testid="chat-count">{props.panels?.chat?.messages.length ?? 0}</output>
      <output data-testid="pending-count">{props.panels?.chat?.pendingMessages?.length ?? 0}</output>
      <output data-testid="transcript-count">{props.panels?.transcript?.transcripts.length ?? 0}</output>
      {props.reconnecting ? <p role="alert">{props.reconnecting.status}</p> : null}
      {props.overlay}
      <button type="button" onClick={props.controls?.onToggleHandRaise}>
        Raise hand
      </button>
      <button type="button" onClick={props.onLeave}>
        Leave Space
      </button>
    </main>
  );

  return {
    CommandErrorAlert: MockCommandErrorAlert,
    ConferenceView: MockSpaceView,
    EndScreen: MockEndScreen,
    JoinFailedScreen: MockJoinFailedScreen,
    JoiningScreen: MockJoiningScreen,
    LeaveDialog: MockLeaveDialog,
    PreJoinScreen: MockPreJoinScreen,
    getThemeMode: () => "dark",
  };
});

import { SdkPreviewGallery } from "./SdkPreviewGallery";

afterEach(cleanup);

function search(overrides: Partial<PreviewSearch>): PreviewSearch {
  return { ...DEFAULT_PREVIEW_SEARCH, ...overrides };
}

describe("SdkPreviewGallery", () => {
  it.each([
    ["ready", "prejoin-screen"],
    ["warning", "prejoin-screen"],
    ["joining", "joining-screen"],
    ["waiting", "joining-screen"],
    ["timeout", "join-failed-screen"],
    ["failure", "join-failed-screen"],
  ] as const)("selects the production Entrance surface for %s", (state, testId) => {
    render(<SdkPreviewGallery search={search({ view: "entrance", state })} onSearchChange={vi.fn()} />);

    expect(screen.getByTestId(testId)).toBeTruthy();
    expect(screen.getByTestId("preview-toolbar")).toBeTruthy();
  });

  it("passes Entrance join settings back to the URL state patch", () => {
    const onSearchChange = vi.fn();
    render(<SdkPreviewGallery search={search({ view: "entrance", state: "ready" })} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Enter Space" }));

    expect(onSearchChange).toHaveBeenCalledWith({ view: "space", state: "happy", mic: true, camera: true, panel: "none", dialog: "none" });
  });

  it.each([
    ["happy", "space-view"],
    ["empty", "space-view"],
    ["warning", "space-view"],
    ["reconnecting", "space-view"],
    ["retry", "space-view"],
    ["confirmation", "space-view"],
    ["timeout", "space-view"],
    ["failure", "space-view"],
    ["ended", "end-screen"],
  ] as const)("selects the production Space surface for %s", (state, testId) => {
    render(<SdkPreviewGallery search={search({ view: "space", state })} onSearchChange={vi.fn()} />);

    expect(screen.getByTestId(testId)).toBeTruthy();
  });

  it("maps participant, chat, transcript, stage, and recovery fixtures to production props", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "reconnecting", participants: 5, panel: "chat", chat: "pending", stage: "share" })} onSearchChange={vi.fn()} />);

    expect(screen.getByTestId("participant-count").textContent).toBe("5");
    expect(screen.getByTestId("active-panel").textContent).toBe("chat");
    expect(screen.getByTestId("pending-count").textContent).toBe("1");
    expect(screen.getByRole("alert").textContent).toContain("reconnecting");
    expect(screen.getByRole("heading", { name: "Design review" })).toBeTruthy();
  });

  it("keeps the direct Empty Space link empty even with default knobs", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "empty", panel: "chat" })} onSearchChange={vi.fn()} />);

    expect(screen.getByTestId("participant-count").textContent).toBe("0");
    expect(screen.getByTestId("chat-count").textContent).toBe("0");
    expect(screen.getByTestId("transcript-count").textContent).toBe("0");
  });

  it("patches shareable control state and confirms leaving the Space", () => {
    const onSearchChange = vi.fn();
    render(<SdkPreviewGallery search={search({ view: "space", state: "confirmation" })} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Raise hand" }));
    expect(onSearchChange).toHaveBeenCalledWith({ hand: true });

    fireEvent.click(screen.getByRole("button", { name: /^Leave$/ }));
    expect(onSearchChange).toHaveBeenCalledWith({ view: "entrance", state: "ready", panel: "none", dialog: "none" });
  });
});
