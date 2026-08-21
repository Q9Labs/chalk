// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const MockPreviewEntrance = ({
    error,
    joining,
    previewError,
    onJoin,
    theme,
  }: {
    readonly error?: string;
    readonly previewError?: string | null;
    readonly joining?: boolean;
    readonly onJoin: (settings: { displayName: string; microphone: boolean; camera: boolean }) => void;
    readonly theme?: { readonly skin?: string; readonly palette?: string; readonly texture?: string };
  }) => (
    <section data-testid="entrance-screen" data-theme-skin={theme?.skin} data-theme-palette={theme?.palette} data-theme-texture={theme?.texture}>
      <h1>{joining ? "Requesting access" : "Enter this Space"}</h1>
      {error || previewError ? <p role="alert">{error ?? previewError}</p> : null}
      {!joining ? (
        <button type="button" onClick={() => onJoin({ displayName: "Ada", microphone: true, camera: true })}>
          Enter Space
        </button>
      ) : null}
    </section>
  );
  const MockPreviewEpisodeEnded = ({ spaceName }: { readonly spaceName?: string }) => <section data-testid="episode-ended">{spaceName}</section>;
  const MockLeaveDialog = ({ isOpen, onClose, onConfirm, onEndEpisode }: { readonly isOpen: boolean; readonly onClose: () => void; readonly onConfirm: () => void; readonly onEndEpisode?: () => void }) =>
    isOpen ? (
      <section role="dialog" aria-label="Leave Space">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          Leave
        </button>
        {onEndEpisode ? (
          <button type="button" onClick={onEndEpisode}>
            End Episode
          </button>
        ) : null}
      </section>
    ) : null;
  const MockCommandErrorAlert = ({ message }: { readonly message?: string }) => (message ? <p role="alert">{message}</p> : null);

  return {
    ...actual,
    CommandErrorAlert: MockCommandErrorAlert,
    PreviewEntrance: MockPreviewEntrance,
    PreviewEpisodeEnded: MockPreviewEpisodeEnded,
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
    ["joining", "entrance-screen"],
    ["waiting", "entrance-screen"],
    ["timeout", "entrance-screen"],
    ["failure", "entrance-screen"],
  ] as const)("selects the production Entrance surface for %s", (state, testId) => {
    render(<SdkPreviewGallery search={search({ view: "entrance", state })} onSearchChange={vi.fn()} />);

    expect(screen.getByTestId(testId)).toBeTruthy();
    expect(screen.getByTestId("preview-toolbar")).toBeTruthy();
  });

  it("passes Entrance join settings back to the URL state patch", () => {
    const onSearchChange = vi.fn();
    render(<SdkPreviewGallery search={search({ view: "entrance", state: "ready" })} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Enter Space" }));

    expect(onSearchChange).toHaveBeenCalledWith({ view: "space", state: "happy", mic: "enabled", camera: "enabled", panel: "none", dialog: "none" });
  });

  it("passes the mapped Cosmic Chalk theme into Entrance", () => {
    render(<SdkPreviewGallery search={search({ view: "entrance", state: "ready", skin: "chalk", palette: "cosmic-chalk", texture: "paper" })} onSearchChange={vi.fn()} />);

    expect(screen.getByTestId("entrance-screen").getAttribute("data-theme-skin")).toBe("chalk");
    expect(screen.getByTestId("entrance-screen").getAttribute("data-theme-palette")).toBe("cosmic-chalk");
    expect(screen.getByTestId("entrance-screen").getAttribute("data-theme-texture")).toBe("paper");
  });

  it("passes the selected skin independently of palette and texture", () => {
    render(<SdkPreviewGallery search={search({ view: "entrance", state: "ready", skin: "chalk", palette: "light", texture: "none" })} onSearchChange={vi.fn()} />);

    expect(screen.getByTestId("entrance-screen").getAttribute("data-theme-skin")).toBe("chalk");
    expect(screen.getByTestId("entrance-screen").getAttribute("data-theme-palette")).toBe("light");
    expect(screen.getByTestId("entrance-screen").getAttribute("data-theme-texture")).toBe("none");
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
    ["leaving", true],
    ["left", true],
    ["ended", false],
  ] as const)("selects the production Space surface for %s", (state, hasSpaceView) => {
    render(<SdkPreviewGallery search={search({ view: "space", state })} onSearchChange={vi.fn()} />);

    expect(hasSpaceView ? screen.getByRole("main") : screen.getByTestId("episode-ended")).toBeTruthy();
  });

  it.each([
    ["failure", "The Space connection failed before recovery completed."],
    ["leaving", "Leaving Design review Space…"],
    ["left", "You have left this Space."],
  ] as const)("uses the shared status surface for %s", (state, message) => {
    render(<SdkPreviewGallery search={search({ view: "space", state })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("status").textContent).toBe(message);
  });

  it("routes an Entrance warning through the production preview error", () => {
    render(<SdkPreviewGallery search={search({ view: "entrance", state: "warning" })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toBe("Preview is unavailable. You can still enter with devices disabled.");
  });

  it("drives the real context-backed composition from the preview snapshot", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "reconnecting", participants: 5, panel: "chat", chat: "pending", stage: "share" })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("main").getAttribute("data-chalk-palette")).toBe("light");
    expect(screen.getByRole("complementary", { name: "Chat panel" })).toBeTruthy();
    expect(screen.getByText("I’m sending the latest Space notes…")).toBeTruthy();
    expect(screen.getByText("The Space connection was interrupted. Reconnecting now…")).toBeTruthy();
    expect(screen.getAllByText("Nora Williams").length).toBeGreaterThan(0);
  });

  it("hydrates Settings from direct palette and texture links", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", dialog: "settings", skin: "chalk", palette: "oled-signal", texture: "slate" })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Space settings" }).getAttribute("data-chalk-skin")).toBe("chalk");
    expect(screen.getByRole("dialog", { name: "Space settings" }).getAttribute("data-chalk-palette")).toBe("oled-signal");
    expect(screen.getByRole("dialog", { name: "Space settings" }).getAttribute("data-chalk-texture")).toBe("slate");
    expect(document.querySelector("[data-chalk-drawer]")).toBeNull();
  });

  it("opens Settings from the production Space button", () => {
    const onSearchChange = vi.fn();
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", dialog: "none" })} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(onSearchChange).toHaveBeenCalledWith({ dialog: "settings" });
  });

  it("does not mount Settings when the settings feature is disabled", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", dialog: "settings", features: { ...DEFAULT_PREVIEW_SEARCH.features, settings: false } })} onSearchChange={vi.fn()} />);

    expect(screen.queryByRole("dialog", { name: "Space settings" })).toBeNull();
  });

  it("keeps Appearance open while switching Settings skins", () => {
    const onSearchChange = vi.fn();
    const chalkSearch = search({ view: "space", state: "happy", dialog: "settings", skin: "chalk" });
    const view = render(<SdkPreviewGallery search={chalkSearch} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Appearance/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Classic/ }));
    expect(onSearchChange).toHaveBeenCalledWith({ skin: "classic" });

    view.rerender(<SdkPreviewGallery search={{ ...chalkSearch, skin: "classic" }} onSearchChange={onSearchChange} />);

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Warm Porcelain/ })).toBeTruthy();
  });

  it("keeps the whiteboard fixture local and network-free", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", stage: "whiteboard" })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("region", { name: "Space stage" })).toBeTruthy();
    expect(screen.queryByTestId("preview-whiteboard")).toBeNull();
  });

  it("keeps the lifecycle state independent from participant and chat fixtures", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "empty", panel: "chat" })} onSearchChange={vi.fn()} />);

    expect(screen.getByRole("complementary", { name: "Chat panel" })).toBeTruthy();
    expect(screen.getByText("The new Space direction feels much calmer.")).toBeTruthy();
  });

  it("auto-opens Participants with Admission from source queue state without a panel query", async () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", panel: "none", admissionQueue: "waiting" })} onSearchChange={vi.fn()} />);

    expect(await screen.findByRole("complementary", { name: "Participants list" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Admission requests" })).toBeTruthy();
  });

  it("patches an allowed incoming camera request", async () => {
    const onSearchChange = vi.fn();
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", incomingMediaRequest: "start-camera", camera: "disabled" })} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith({ incomingMediaRequest: "none", camera: "enabled" }));
  });

  it("patches a declined incoming microphone request", async () => {
    const onSearchChange = vi.fn();
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", incomingMediaRequest: "unmute" })} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith({ incomingMediaRequest: "none" }));
  });

  it("shows a local diagnostics toast", async () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "happy", diagnostics: true })} onSearchChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

    expect(await screen.findByText("Diagnostics invoked locally for this preview.")).toBeTruthy();
  });

  it("patches shareable control state and confirms leaving the Space", () => {
    const onSearchChange = vi.fn();
    render(<SdkPreviewGallery search={search({ view: "space", state: "confirmation" })} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByTestId("preview-toolbar"));
    expect(onSearchChange).toHaveBeenCalledWith({ hand: true });

    fireEvent.click(screen.getAllByRole("button", { name: "Leave" }).at(-1)!);
    expect(onSearchChange).toHaveBeenCalledWith({ view: "space", state: "leaving" });
  });

  it.each(["owner", "collaborator", "observer"] as const)("exposes End Episode for the full capability preset regardless of role: %s", (role) => {
    const onSearchChange = vi.fn();
    render(<SdkPreviewGallery search={search({ view: "space", state: "confirmation", role, capability: "full" })} onSearchChange={onSearchChange} />);

    fireEvent.click(screen.getByRole("button", { name: "End Episode" }));

    expect(onSearchChange).toHaveBeenCalledWith({ view: "space", state: "ended" });
  });

  it("hides End Episode when the capability preset does not include it", () => {
    render(<SdkPreviewGallery search={search({ view: "space", state: "confirmation", role: "owner", capability: "collaborator" })} onSearchChange={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "End Episode" })).toBeNull();
  });
});
