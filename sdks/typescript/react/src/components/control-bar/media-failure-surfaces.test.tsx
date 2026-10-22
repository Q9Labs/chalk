// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { ControlBar } from "./ControlBar";
import { ScreenSharePresentation } from "../composite/ScreenShareView";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { MediaRequestDialog } from "../media-request-dialog/MediaRequestDialog";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("standalone ControlBar uses safe camera failure guidance", async () => {
  const snapshot = createSnapshot(["publishVideo"]);
  const preview = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
  const message = "setCameraEnabled belongs to an inactive connection";
  const client = {
    ...preview,
    media: {
      ...preview.media,
      setCameraEnabled: async () => {
        throw new Error(message);
      },
    },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <ControlBar buttons={["video"]} />
        </ChalkProvider>,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>('[data-part="video-split"] .chalk-shell-main');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    const actual = container.querySelector('[role="alert"]')?.textContent;

    expect(actual).toBe("Couldn’t change your camera settings.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    preview.dispose();
  }
});

it("stage screen-share stop uses safe media failure guidance", async () => {
  const message = "startScreenShare belongs to an inactive connection";
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ScreenSharePresentation
          sharedByName="You"
          isLocal
          media={null}
          mediaVisible
          state="live"
          onStopSharing={async () => {
            throw new SpaceClientError({ code: "connection.invalid_state", message, recoverable: false });
          }}
        />,
      ),
    );
    const button = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Stop sharing");
    expect(button).not.toBeUndefined();
    await act(async () => button?.click());
    const actual = container.querySelector('[role="alert"]')?.textContent;

    expect(actual).toBe("That change was interrupted.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("standalone MediaRequestDialog uses safe camera failure guidance", async () => {
  const message = "setCameraEnabled belongs to an inactive connection";
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MediaRequestDialog
          request={{ requestId: "judge-request", kind: "start_camera", expiresAt: new Date(Date.now() + 60000).toISOString(), actorParticipantId: "host", actorDisplayName: "Host" }}
          onDecline={() => {}}
          onAllow={async () => {
            throw new SpaceClientError({ code: "connection.invalid_state", message, recoverable: false });
          }}
        />,
      ),
    );
    const button = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Allow"));
    expect(button).not.toBeUndefined();
    await act(async () => button?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("That change was interrupted.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["Allow", "Not now"])("uses safe microphone guidance for standalone %s requests", async (action) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const onActionError = vi.fn();
  const reject = async () => {
    throw new Error("setMicrophoneEnabled belongs to an inactive connection");
  };
  try {
    await act(async () => root.render(<MediaRequestDialog request={{ requestId: "mic-request", kind: "unmute", expiresAt: new Date(Date.now() + 60000).toISOString(), actorParticipantId: "host", actorDisplayName: "Host" }} onDecline={reject} onAllow={reject} onActionError={onActionError} />));
    const button = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === action);
    if (!button) throw new Error("Missing request action");
    await act(async () => button.click());
    const safe = "Couldn’t change your microphone settings.";
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(safe);
    expect(onActionError).toHaveBeenCalledWith(safe, action === "Allow" ? "allow" : "decline");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("uses safe screen guidance when changing the shared surface", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ScreenSharePresentation
          sharedByName="You"
          isLocal
          media={null}
          mediaVisible
          state="live"
          onChangeShare={async () => {
            throw new Error("startScreenShare belongs to an inactive connection");
          }}
        />,
      ),
    );
    const change = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Change");
    if (!change) throw new Error("Missing Change control");
    await act(async () => change.click());
    const tab = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "Browser tab");
    if (!(tab instanceof HTMLElement)) throw new Error("Missing Browser tab option");
    await act(async () => tab.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t change screen sharing.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it.each(["fullscreen", "picture-in-picture"])("preserves %s errors", async (operation) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const message = `${operation} is blocked by this browser.`;
  try {
    await act(async () =>
      root.render(
        <div data-part="stage-tile">
          <ScreenSharePresentation sharedByName="Nora" media={<video />} mediaVisible />
        </div>,
      ),
    );
    const tile = Array.from(container.querySelectorAll('[data-part="stage-tile"]')).at(-1);
    if (!tile) throw new Error("Missing stage tile");
    const video = container.querySelector("video");
    if (!video) throw new Error("Missing video");
    if (operation === "fullscreen")
      Object.defineProperty(tile, "requestFullscreen", {
        configurable: true,
        value: async () => {
          throw new Error(message);
        },
      });
    else {
      Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, value: true });
      Object.defineProperty(video, "requestPictureInPicture", {
        configurable: true,
        value: async () => {
          throw new Error(message);
        },
      });
    }
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${operation === "fullscreen" ? "Full screen" : "Pop out"}"]`);
    if (!button) throw new Error("Missing display control");
    await act(async () => button.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "pictureInPictureEnabled");
  }
});

it.each(["camera", "microphone"] as const)("standalone %s disable failures use action-neutral guidance", async (source) => {
  const preview = createPreviewClient(createSnapshot(["publishAudio", "publishVideo"]));
  await preview.media.setCameraEnabled(true);
  await preview.media.setMicrophoneEnabled(true);
  const failure = async () => {
    throw new SpaceClientError({ code: "media.capture_failed", recoverable: true, message: `Could not pause ${source}` });
  };
  const client = { ...preview, media: { ...preview.media, setCameraEnabled: failure, setMicrophoneEnabled: failure } };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <ControlBar buttons={[source === "camera" ? "video" : "mic"]} />
        </ChalkProvider>,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(`[data-part="${source === "camera" ? "video" : "mic"}-split"] .chalk-shell-main`);
    expect(button?.getAttribute("aria-label")).toBe(source === "camera" ? "Turn off camera" : "Mute microphone");
    await act(async () => button?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(`Couldn’t change your ${source} settings. Try again.`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    preview.dispose();
  }
});

it("screen Off capture failure does not suggest granting capture permission", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ScreenSharePresentation
          sharedByName="You"
          isLocal
          media={null}
          mediaVisible
          state="live"
          onStopSharing={async () => {
            throw new SpaceClientError({ code: "media.capture_failed", recoverable: true, message: "Could not pause screen" });
          }}
        />,
      ),
    );
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "Stop sharing");
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t stop screen sharing. Try again.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["camera", "microphone"] as const)("standalone %s Start capture failure keeps start guidance", async (source) => {
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
          <ControlBar buttons={[source === "camera" ? "video" : "mic"]} />
        </ChalkProvider>,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(`[data-part="${source === "camera" ? "video" : "mic"}-split"] .chalk-shell-main`);
    expect(button?.getAttribute("aria-label")).toBe(source === "camera" ? "Turn on camera" : "Unmute microphone");
    await act(async () => button?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(`Your ${source} couldn’t start. Check that it is connected and available, then try again.`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    preview.dispose();
  }
});

it("withdrawn media requests show terminal guidance without retry advice", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MediaRequestDialog
          request={{ requestId: "withdrawn", kind: "start_camera", expiresAt: new Date(Date.now() + 60000).toISOString(), actorParticipantId: "host", actorDisplayName: "Host" }}
          onDecline={() => {}}
          onAllow={async () => {
            throw new SpaceClientError({ code: "media.request_invalid", recoverable: false, message: "The media request is no longer active" });
          }}
        />,
      ),
    );
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "Allow");
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The media request is no longer active.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
