// @vitest-environment happy-dom
import { act } from "react";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot as createIdleSnapshot } from "../../test-support/preview-client";
import { ControlBar, ControlBarPresentation } from "./ControlBar";
import { useConnectedControlBarBehavior } from "./control-bar-behavior";
import { useScreenShare } from "../../bindings/hooks";

function createSnapshot(...args: Parameters<typeof createIdleSnapshot>) {
  const snapshot = createIdleSnapshot(...args);
  return { ...snapshot, connection: { ...snapshot.connection, status: "live" as const } };
}

describe("compact screen sharing", () => {
  it("starts and stops screen sharing", async () => {
    const onCommand = vi.fn();
    const client = createPreviewClient(undefined, { onCommand });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <>
            <ChalkProvider client={client}>
              <ControlBar density="compact" buttons={["screenshare"]} />
            </ChalkProvider>
          </>,
        ),
      );
      expect(container.querySelector('[data-tour="controls-screenshare"]')).toBeNull();
      await act(async () => client.setSnapshot(createSnapshot(["publishScreen"])));
      const start = container.querySelector('button[aria-label="Share screen"]');
      if (!(start instanceof HTMLButtonElement)) throw new Error("Compact screen-share control is missing");
      await act(async () => start.click());
      expect(onCommand).toHaveBeenCalledWith({ type: "setScreenShareEnabled", enabled: true }, expect.anything());
      const stop = container.querySelector('button[aria-label="Stop sharing"]');
      if (!(stop instanceof HTMLButtonElement)) throw new Error("Compact stop-sharing control is missing");
      await act(async () => stop.click());
      expect(onCommand).toHaveBeenCalledWith({ type: "setScreenShareEnabled", enabled: false }, expect.anything());
    } finally {
      await act(async () => root.unmount());
      container.remove();
      client.dispose();
    }
  });
});

describe("media command failures", () => {
  it("preserves public codes and reports the originating media source", async () => {
    const preview = createPreviewClient(createSnapshot(["publishAudio", "publishVideo", "publishScreen"]));
    const onCommandError = vi.fn();
    const client = {
      ...preview,
      media: {
        ...preview.media,
        setMicrophoneEnabled: async () => {
          throw new SpaceClientError({ code: "media.permission_denied", recoverable: true, message: "Blocked microphone" });
        },
        setCameraEnabled: async () => {
          throw new SpaceClientError({ code: "media.device_not_found", recoverable: true, message: "Missing camera" });
        },
        setScreenShareEnabled: async () => {
          throw new Error("Capture failed");
        },
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ChalkProvider client={client}>
            <ControlBar buttons={["mic", "video", "screenshare"]} onCommandError={onCommandError} />
          </ChalkProvider>,
        ),
      );
      for (const [part, code, source] of [
        ["mic", "media.permission_denied", "microphone"],
        ["video", "media.device_not_found", "camera"],
        ["share", "client.internal_error", "screen"],
      ]) {
        const button = container.querySelector(`[data-part="${part}-split"] .chalk-shell-main`);
        if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing ${part} control`);
        await act(async () => button.click());
        expect(onCommandError).toHaveBeenLastCalledWith(expect.objectContaining({ code }), source, source);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      preview.dispose();
    }
  });
});

it("requests a replacement without first disabling an active screen share", async () => {
  const onCommand = vi.fn();
  const client = createPreviewClient(createSnapshot(["publishScreen"]), { onCommand });
  await client.media.setScreenShareEnabled(true);
  onCommand.mockClear();
  function ChangeShare() {
    const { surfaceProps } = useConnectedControlBarBehavior({});
    return <button onClick={() => surfaceProps.onStartScreenShare?.({ surface: "browser" })}>Change share</button>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <ChangeShare />
        </ChalkProvider>,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith({ type: "setScreenShareEnabled", enabled: true }, expect.anything());
  } finally {
    await act(async () => root.unmount());
    client.dispose();
    container.remove();
  }
});

describe("Sync availability", () => {
  it("keeps device menus and phone camera selection available without allowing media enable", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onVideoInputChange = vi.fn();
    try {
      await act(async () =>
        root.render(
          <ControlBarPresentation
            isMuted
            isVideoEnabled={false}
            mediaEnableDisabled
            videoInputDevices={[
              { deviceId: "front", label: "Front" },
              { deviceId: "back", label: "Back" },
            ]}
            selectedVideoInput="front"
            onVideoInputChange={onVideoInputChange}
          />,
        ),
      );
      for (const label of ["Unmute microphone", "Turn on camera"]) expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.disabled).toBe(true);
      for (const label of ["Select microphone", "Select camera"]) expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.disabled).toBe(false);
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More options"]')?.click());
      const flip = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Flip camera"));
      expect(flip?.disabled).toBe(false);
      await act(async () => flip?.click());
      expect(onVideoInputChange).toHaveBeenCalledWith("back");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("keeps the screen-share action stable across media snapshot updates", async () => {
    const client = createPreviewClient(createSnapshot(["publishScreen"]));
    const actions: ReturnType<typeof useScreenShare>["setEnabled"][] = [];
    function Probe() {
      actions.push(useScreenShare().setEnabled);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () =>
        root.render(
          <ChalkProvider client={client}>
            <Probe />
          </ChalkProvider>,
        ),
      );
      const initial = actions.at(-1);
      await act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, media: { ...snapshot.media, screenShare: { ...snapshot.media.screenShare, state: "enabled" } } })));
      expect(actions.length).toBeGreaterThan(1);
      expect(actions.at(-1)).toBe(initial);
    } finally {
      await act(async () => root.unmount());
      client.dispose();
    }
  });

  it("disables media enable and reactions during recovery, preserves mute and chat, and restores on live", async () => {
    const snapshot = createSnapshot(["publishAudio", "publishVideo", "publishScreen", "sendReaction"]);
    const onCommand = vi.fn();
    const client = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "reconnecting" } }, { onCommand });
    const container = document.createElement("div");
    const root = createRoot(container);
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    try {
      await act(async () =>
        root.render(
          <ChalkProvider client={client}>
            <ControlBar onToggleChat={() => {}} onOpenReactions={() => {}} />
          </ChalkProvider>,
        ),
      );
      expect(button("Unmute microphone")?.disabled).toBe(true);
      expect(button("Turn on camera")?.disabled).toBe(true);
      expect(button("Share screen")?.disabled).toBe(true);
      expect(button("Reactions")?.disabled).toBe(true);
      expect(button("Chat")?.disabled).toBe(false);
      await act(async () => client.updateSnapshot((current) => ({ ...current, media: { ...current.media, local: { ...current.media.local, microphone: { ...current.media.local.microphone, state: "enabled" } } } })));
      expect(button("Mute microphone")?.disabled).toBe(false);
      await act(async () => client.updateSnapshot((current) => ({ ...current, media: { ...current.media, local: { ...current.media.local, screen: { ...current.media.local.screen, state: "enabled" } } } })));
      expect(button("Stop sharing")?.disabled).toBe(false);
      expect(button("Share options")?.disabled).toBe(true);
      await act(async () => button("Share options")?.click());
      expect(onCommand).not.toHaveBeenCalled();
      await act(async () => button("Stop sharing")?.click());
      expect(onCommand).toHaveBeenCalledWith({ type: "setScreenShareEnabled", enabled: false }, expect.anything());
      await act(async () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live", syncHealth: "degraded" } })));
      expect(button("Turn on camera")?.disabled).toBe(false);
      expect(button("Reactions")?.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      client.dispose();
    }
  });
});

it.each([false, true])("keeps hand controls available while reactions are gated (raised=%s)", async (raised) => {
  const toggle = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ControlBarPresentation buttons={["handraise", "reactions"]} reactionsDisabled onOpenReactions={() => {}} onToggleHandRaise={toggle} isHandRaised={raised} detectDevices={false} />));
    const hand = container.querySelector<HTMLButtonElement>(`button[aria-label="${raised ? "Lower hand" : "Raise hand"}"]`);
    expect(hand).not.toBeNull();
    expect(hand?.disabled).toBe(false);
    await act(async () => hand?.click());
    expect(toggle).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Reactions"]')?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps the legacy speaker callback source empty while providing optional media context", async () => {
  const preview = createPreviewClient(createSnapshot(["publishAudio"]));
  const failure = new SpaceClientError({ code: "environment.unsupported", recoverable: false, message: "Speaker selection is not supported" });
  const client = {
    ...preview,
    media: {
      ...preview.media,
      selectSpeaker: async () => {
        throw failure;
      },
    },
  };
  const onCommandError = vi.fn();
  function SpeakerSelection() {
    const { surfaceProps } = useConnectedControlBarBehavior({ onCommandError });
    return <button onClick={() => surfaceProps.onAudioOutputChange?.("speaker")}>Choose speaker</button>;
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpeakerSelection />
        </ChalkProvider>,
      ),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(onCommandError).toHaveBeenLastCalledWith(failure, undefined, "speaker");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    preview.dispose();
  }
});
