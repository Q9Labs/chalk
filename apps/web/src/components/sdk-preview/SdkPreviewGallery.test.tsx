// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREVIEW_SEARCH, type PreviewSearch } from "./preview-state";

vi.mock("./PreviewGalleryToolbar", () => ({
  PreviewGalleryToolbar: ({ search, onChange }: { readonly search: PreviewSearch; readonly onChange: (patch: Partial<PreviewSearch>) => void }) => (
    <button type="button" data-testid="preview-toolbar" onClick={() => onChange({ hand: !search.hand })}>
      Preview controls
    </button>
  ),
}));

vi.mock("../../../../../sdks/typescript/react/src/test-support/preview-fixtures", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../sdks/typescript/react/src/test-support/preview-fixtures")>();
  const MockPreviewEntrance = ({ error, onJoin, theme }: { readonly error?: string; readonly onJoin: (settings: { displayName: string; microphone: boolean; camera: boolean }) => void; readonly theme?: { readonly palette?: string; readonly texture?: string } }) => (
    <section data-testid="entrance-screen" data-theme-palette={theme?.palette} data-theme-texture={theme?.texture}>
      <h1>Entrance</h1>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={() => onJoin({ displayName: "Ada", microphone: true, camera: true })}>
        Enter Space
      </button>
    </section>
  );
  const MockPreviewJoiningScreen = ({ message }: { readonly message?: string }) => <div data-testid="joining-screen">{message}</div>;
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
  const MockPreviewEpisodeEnded = ({ spaceName }: { readonly spaceName?: string }) => <section data-testid="episode-ended">{spaceName}</section>;
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

  return {
    ...actual,
    CommandErrorAlert: MockCommandErrorAlert,
    PreviewEntrance: MockPreviewEntrance,
    PreviewEpisodeEnded: MockPreviewEpisodeEnded,
    PreviewJoiningScreen: MockPreviewJoiningScreen,
    JoinFailedScreen: MockJoinFailedScreen,
    LeaveDialog: MockLeaveDialog,
  };
});

import { SdkPreviewGallery } from "./SdkPreviewGallery";

afterEach(cleanup);

function search(overrides: Partial<PreviewSearch>): PreviewSearch {
  return { ...DEFAULT_PREVIEW_SEARCH, ...overrides };
}

describe("SdkPreviewGallery", () => {
  it.each([
    ["ready", "entrance-screen"],
    ["warning", "entrance-screen"],
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

  it("passes the mapped Cosmic Chalk theme into Entrance", () => {
    render(<SdkPreviewGallery search={search({ view: "entrance", state: "ready", palette: "cosmic" })} onSearchChange={vi.fn()} />);

    expect(screen.getByTestId("entrance-screen").getAttribute("data-theme-palette")).toBe("cosmic-chalk");
    expect(screen.getByTestId("entrance-screen").getAttribute("data-theme-texture")).toBe("paper");
  });

  it.each([
    ["happy", true],
    ["empty", true],
    ["warning", true],
    ["reconnecting", true],
    ["retry", true],
    ["confirmation", true],
    ["timeout", true],
    ["failure", true],
    ["ended", false],
  ] as const)("selects the production Space surface for %s", (state, hasSpaceView) => {
    render(<SdkPreviewGallery search={search({ view: "space", state })} onSearchChange={vi.fn()} />);

    expect(hasSpaceView ? screen.getByRole("main") : screen.getByTestId("episode-ended")).toBeTruthy();
  });

  it("drives the real context-backed composition from the preview snapshot", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "reconnecting", participants: 5, panel: "chat", chat: "pending", stage: "share" })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("main").getAttribute("data-chalk-palette")).toBe("warm-charcoal");
    expect(screen.getByRole("complementary", { name: "Chat panel" })).toBeTruthy();
    expect(screen.getByText("I’m sending the latest Space notes…")).toBeTruthy();
    expect(screen.getByText("The Space connection was interrupted. Reconnecting now…")).toBeTruthy();
    expect(screen.getByText("Nora Williams")).toBeTruthy();
  });

  it("hydrates Settings from direct palette and texture links", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", dialog: "settings", palette: "midnight", texture: "soft-dots" })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Space settings" }).getAttribute("data-chalk-palette")).toBe("oled-signal");
    expect(screen.getByRole("dialog", { name: "Space settings" }).getAttribute("data-chalk-texture")).toBe("slate");
  });

  it("keeps the whiteboard fixture local and network-free", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", stage: "whiteboard" })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByTestId("preview-whiteboard")).toBeTruthy();
    expect(document.head.querySelector('link[href*="jsdelivr"], link[href*="excalidraw"]')).toBeNull();
  });

  it("keeps the direct Empty Space link empty even with default knobs", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "empty", panel: "chat" })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("complementary", { name: "Chat panel" })).toBeTruthy();
    expect(screen.queryByText("The new Space direction feels much calmer.")).toBeNull();
  });

  it("patches shareable control state and confirms leaving the Space", () => {
    const onSearchChange = vi.fn();
    render(<SdkPreviewGallery search={search({ view: "space", state: "confirmation" })} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByTestId("preview-toolbar"));
    expect(onSearchChange).toHaveBeenCalledWith({ hand: true });

    fireEvent.click(screen.getAllByRole("button", { name: "Leave" }).at(-1)!);
    expect(onSearchChange).toHaveBeenCalledWith({ view: "entrance", state: "ready", panel: "none", dialog: "none" });
  });
});
