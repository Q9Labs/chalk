// @vitest-environment happy-dom
import type { ScreenShareOptions } from "@q9labsai/chalk-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { ScreenSharePresentation, ScreenShareView } from "./ScreenShareView";
import { SpaceView } from "../space-view/SpaceView";

it.each([
  [null, "your screen"],
  ["monitor", "your screen"],
  ["window", "a window"],
  ["browser", "a tab"],
] as const)("describes the reported capture surface without guessing: %s", async (surface, description) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ScreenSharePresentation sharedByName="You" media={null} mediaVisible isLocal capture={{ surface, label: "Primary Monitor" }} />));
    expect(container.textContent).toContain(`You’re sharing ${description}`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  { isLocal: true, stage: false },
  { isLocal: false, stage: false },
  { isLocal: true, stage: true },
])("preserves share ownership and recovery restrictions: %j", async ({ isLocal, stage }) => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const track: MediaStreamTrack = {
    id: "screen",
    kind: "video",
    label: "Slides",
    enabled: true,
    muted: false,
    readyState: "live",
    contentHint: "",
    onended: null,
    onmute: null,
    onunmute: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    applyConstraints: async () => {},
    clone: () => track,
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    getSettings: () => ({}),
    stop: vi.fn(),
  };
  const base = createSnapshot(["publishScreen"]);
  const client = createPreviewClient({
    ...base,
    connection: { ...base.connection, status: "live" },
    self: { ...base.self, participantId: "self", displayName: "You" },
    participants: {
      ...base.participants,
      roster: [
        {
          participantId: isLocal ? "self" : "peer",
          displayName: "Nora",
          role: "member",
          eligibleRoles: [],
          capabilities: ["publishScreen"],
          handRaised: false,
          media: { microphone: "inactive", camera: "inactive", screenShare: "active", screenShareHasAudio: true },
          presence: { state: "connected", speaking: false, activeSpeaker: false },
        },
      ],
    },
    media: {
      ...base.media,
      local: { ...base.media.local, screen: { source: "screen", state: isLocal ? "enabled" : "disabled", track: isLocal ? track : null } },
      remote: isLocal ? [] : [{ participantId: "peer", source: "screen", track }],
      screenShare: { source: "screen", state: "enabled", track, hasAudio: true, capture: { surface: "browser", label: "Slides" } },
    },
  });
  const share = vi.fn<(enabled: boolean, options?: ScreenShareOptions) => Promise<void>>().mockResolvedValue();
  const connected = { ...client, media: { ...client.media, setScreenShareEnabled: share } };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ChalkProvider client={connected}>{stage ? <SpaceView features={{ sounds: false }} generatedAvatars={false} /> : <ScreenShareView />}</ChalkProvider>));
    await act(async () => container.querySelector("video")?.dispatchEvent(new Event("loadeddata")));
    if (isLocal) {
      expect(container.textContent).toContain("Your screen");
      expect(container.textContent).toContain("You’re sharing a tab");
      expect(container.querySelector('[aria-label="Pop out"]')).toBeNull();
      const change = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Change");
      if (!change) throw new Error("Missing Change share control");
      await act(async () => change.click());
      const tab = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "Browser tab");
      if (!(tab instanceof HTMLElement)) throw new Error("Missing Browser tab action");
      await act(async () => tab.click());
      expect(share).toHaveBeenLastCalledWith(true, { surface: "browser", audio: true });
      await act(async () => change.click());
      await act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, connection: { ...snapshot.connection, status: "reconnecting" } })));
      expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Change")).toBeUndefined();
      expect(document.querySelector('[role="menuitem"]')).toBeNull();
      expect(share).toHaveBeenCalledTimes(1);
      const stop = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Stop sharing");
      if (!stop) throw new Error("Missing Stop sharing control");
      await act(async () => stop.click());
      expect(share).toHaveBeenLastCalledWith(false);
    } else {
      expect(container.textContent).toContain("Nora's screen");
      expect(container.textContent).not.toContain("Stop sharing");
      expect(container.querySelector('[aria-label="Pop out"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="With share audio"]')).not.toBeNull();
      expect(share).not.toHaveBeenCalled();
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
