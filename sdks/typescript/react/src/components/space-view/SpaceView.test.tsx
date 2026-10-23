// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { liveMediaClient } from "../../../tests/helpers/live-media";
import { SpaceView } from "./SpaceView";

it.each([
  { capability: "publishVideo", label: "Turn on camera" },
  { capability: "publishAudio", label: "Unmute microphone" },
  { capability: "publishScreen", label: "Share screen" },
] as const)("checks the current connection before retrying $capability", async ({ capability, label }) => {
  const fixture = await liveMediaClient();
  const { client } = fixture;
  const capture = capability === "publishScreen" ? fixture.display : fixture.capture;
  capture.mockRejectedValue(new DOMException("Device busy", "NotReadableError"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click());
    await act(async () => vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1)));
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Try again")));
    const retry = () => {
      const button = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Try again");
      if (!button) throw new Error("Missing media retry");
      return button;
    };
    await act(async () => fixture.health(true));
    await act(async () => retry().click());
    await expect((capability === "publishVideo" ? fixture.actions.camera : capability === "publishAudio" ? fixture.actions.microphone : fixture.actions.screen).mock.results.at(-1)?.value).rejects.toMatchObject({ code: "connection.invalid_state" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("That change was interrupted.");
    expect(container.textContent).toContain("Try again");
    await act(async () => fixture.health(false));
    await act(async () => retry().click());
    await act(async () => vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2)));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
    vi.restoreAllMocks();
  }
});

it("blocks push-to-talk during recovery but still releases a live press after recovery starts", async () => {
  const snapshot = createSnapshot(["publishAudio"]);
  const onCommand = vi.fn();
  const client = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "reconnecting" } }, { onCommand });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const key = (type: "keydown" | "keyup") => document.body.dispatchEvent(new KeyboardEvent(type, { key: " ", code: "Space", bubbles: true, cancelable: true }));
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    await act(async () => {
      key("keydown");
      key("keyup");
    });
    expect(onCommand).not.toHaveBeenCalledWith({ type: "setMicrophoneEnabled", enabled: true }, expect.anything());
    await act(async () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live" } })));
    await act(async () => {
      key("keydown");
    });
    expect(onCommand).toHaveBeenLastCalledWith({ type: "setMicrophoneEnabled", enabled: true }, expect.anything());
    await act(async () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "reconnecting" } })));
    await act(async () => {
      key("keyup");
    });
    expect(onCommand).toHaveBeenLastCalledWith({ type: "setMicrophoneEnabled", enabled: false }, expect.anything());
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it.each(["observer", "custom-reader"])("keeps chat history available without write actions for %s", async (role) => {
  const base = createSnapshot([]);
  const client = createPreviewClient({
    ...base,
    self: { ...base.self, participantId: "self", role },
    chat: {
      ...base.chat,
      status: "ready",
      messages: [
        {
          messageId: "message-1",
          clientMessageId: "client-message-1",
          sequence: "1",
          participantId: "peer",
          displayName: "Peer",
          text: "Welcome to the call",
          createdAt: "2026-10-18T00:00:00Z",
          attachments: [],
          reactions: [{ emoji: "👏", count: 1, participantIds: ["peer"] }],
          reactionRevision: "1",
        },
      ],
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView spaceName="Test call" initialPanel="chat" features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    expect(container.textContent).toContain("Welcome to the call");
    expect(container.querySelector('[aria-label="Message"]')).toHaveProperty("disabled", true);
    expect(container.querySelector('[aria-label="Send message"]')).toHaveProperty("disabled", true);
    expect(container.querySelector('[aria-label="Attach files"]')).toBeNull();
    expect(container.querySelector('[aria-label="React to this message"]')).toBeNull();
    expect(container.querySelector('[aria-label="👏, 1: peer"]')).toHaveProperty("disabled", true);
    const chatButton = container.querySelector('[aria-label="Chat"]');
    expect(chatButton).not.toBeNull();

    const writer = createSnapshot(["sendChat"]);
    await act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, self: { ...snapshot.self, capabilities: writer.self.capabilities, can: writer.self.can } })));
    expect(container.querySelector('[aria-label="Message"]')).toHaveProperty("disabled", false);
    expect(container.querySelector('[aria-label="Attach files"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="React to this message"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it.each(["camera", "microphone", "push-to-talk"] as const)("keeps start intent in %s shortcut failures", async (shortcut) => {
  const snapshot = createSnapshot(["publishAudio", "publishVideo"]);
  const preview = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
  const fail = async () => {
    throw new SpaceClientError({ code: "media.capture_failed", recoverable: true, message: "Capture implementation details" });
  };
  const client = { ...preview, media: { ...preview.media, setCameraEnabled: fail, setMicrophoneEnabled: fail } };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: shortcut === "camera" ? "e" : shortcut === "microphone" ? "d" : " ", code: shortcut === "push-to-talk" ? "Space" : undefined, ctrlKey: shortcut !== "push-to-talk", bubbles: true, cancelable: true })));
    expect(container.textContent).toContain(`Your ${shortcut === "camera" ? "camera" : "microphone"} couldn’t start.`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    preview.dispose();
  }
});

it("retries a failed screen Off command as Off, not Start", async () => {
  const snapshot = createSnapshot(["publishScreen"]);
  const preview = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
  await preview.media.setScreenShareEnabled(true);
  const stop = vi.fn(async () => {
    throw new SpaceClientError({ code: "media.capture_failed", recoverable: true, message: "Could not pause screen" });
  });
  const client = { ...preview, media: { ...preview.media, setScreenShareEnabled: stop } };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('[data-part="share-split"] .chalk-shell-main')?.click());
    expect(container.textContent).toContain("Couldn’t stop screen sharing.");
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Try again");
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(stop.mock.calls).toEqual([[false], [false]]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    preview.dispose();
  }
});

it("retains live drawing permission updates alongside the offline notice", async () => {
  const base = createSnapshot(["drawWhiteboard"]);
  const warning = "Your expired offline actions were not sent.";
  const client = createPreviewClient({ ...base, connection: { ...base.connection, status: "live" }, offline: { ...base.offline, notice: warning } });
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} onToggleWhiteboard={() => {}} />
        </ChalkProvider>,
      ),
    );
    expect(container.querySelector('[aria-label="Board"]')).not.toBeNull();
    expect(container.textContent).toContain(warning);
    await act(async () => client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, engine: { ...current.whiteboard.engine, status: "ready" }, access: { ...current.whiteboard.access, policy: "everyone", canDraw: false } } })));
    expect(container.querySelector('[aria-label="Board"]')).toBeNull();
    expect(container.textContent).toContain(warning);
    await act(async () => client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, access: { ...current.whiteboard.access, canDraw: true } } })));
    expect(container.querySelector('[aria-label="Board"]')).not.toBeNull();
    expect(container.textContent).toContain(warning);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("keeps an expired warning reachable and dismissed through Notices and rotation", async () => {
  let callHeight = 320;
  const callbacks = new Set<(entries: ResizeObserverEntry[]) => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private notify: (entries: ResizeObserverEntry[]) => void) {}
      observe() {
        callbacks.add(this.notify);
      }
      disconnect() {
        callbacks.delete(this.notify);
      }
    },
  );
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => callHeight);
  const base = createSnapshot([]);
  const warning = "Your expired offline actions were not sent. Actions are kept for up to 24 hours.";
  const client = createPreviewClient({ ...base, connection: { ...base.connection, status: "live" }, offline: { ...base.offline, notice: warning } });
  const frame = document.createElement("main");
  document.body.append(frame);
  const root = createRoot(frame);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} commandError="Camera blocked" />
        </ChalkProvider>,
      ),
    );
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
    expect(frame.querySelector("[data-part=notice-button]")?.getAttribute("aria-label")).toBe("Show 2 notices");
    await act(async () => frame.querySelector<HTMLButtonElement>("[data-part=notice-button]")!.click());
    const notice = [...document.querySelectorAll("[data-part=notice]")].find((node) => node.textContent?.includes(warning));
    expect(notice).toBeDefined();
    expect(document.querySelectorAll("[data-part=notice]")).toHaveLength(2);
    await act(async () => notice!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    expect(frame.querySelector("[data-part=notice-button]")?.getAttribute("aria-label")).toBe("Show 1 notice");
    expect([...document.querySelectorAll("[data-part=notice]")].some((node) => node.textContent?.includes(warning))).toBe(false);
    await act(async () => {
      callHeight = 844;
      for (const callback of [...callbacks]) callback([]);
    });
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(1);
    expect(frame.querySelector("[data-part=toast]")?.textContent).not.toContain(warning);
    await act(async () => {
      callHeight = 320;
      for (const callback of [...callbacks]) callback([]);
    });
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
    expect(frame.querySelector("[data-part=notice-button]")?.getAttribute("aria-label")).toBe("Show 1 notice");
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    client.dispose();
    height.mockRestore();
    vi.unstubAllGlobals();
  }
});
