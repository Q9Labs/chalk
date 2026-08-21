// @vitest-environment happy-dom

import type { Capability, ChalkWhiteboardV1Transport, ChatUploadFile, SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import { act, cleanup, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Chalk, ChalkProvider, useCan, useChat, useConnection, useMedia, useParticipants, useReactions, useSelf, useSpaceClient, useWhiteboard } from "../index";
import { createFakeMediaStreamTrack } from "../test-support/fake-media-track";

const createSpaceClientSpy = vi.hoisted(() => vi.fn());
const screenShareSpy = vi.hoisted(() =>
  vi.fn((props: { readonly screenShareTrack: MediaStreamTrack; readonly sharedByName: string; readonly onStopShare?: () => void }) => (
    <button type="button" onClick={props.onStopShare}>
      Stop active share
    </button>
  )),
);
const whiteboardViewSpy = vi.hoisted(() => vi.fn(() => <div role="region" aria-label="Shared whiteboard" />));

vi.mock("@q9labsai/chalk-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@q9labsai/chalk-client")>()),
  createSpaceClient: createSpaceClientSpy,
}));
vi.mock("../components/composite/ScreenShareView", () => ({ ScreenShareViewSurface: screenShareSpy }));
vi.mock("../components/whiteboard-view/WhiteboardView", () => ({ WhiteboardView: whiteboardViewSpy }));

type TestClient = SpaceClient & {
  readonly setSnapshot: (snapshot: SpaceSnapshot) => void;
};

afterEach(() => {
  cleanup();
  createSpaceClientSpy.mockReset();
  vi.unstubAllGlobals();
});

describe("React bindings", () => {
  it("binds every public snapshot hook directly to the SpaceClient store", () => {
    const client = createTestClient();
    const wrapper = ({ children }: PropsWithChildren) => <ChalkProvider client={client}>{children}</ChalkProvider>;
    const { result } = renderHook(
      () => ({
        client: useSpaceClient(),
        connection: useConnection(),
        self: useSelf(),
        participants: useParticipants(),
        media: useMedia(),
        chat: useChat(),
        reactions: useReactions(),
        whiteboard: useWhiteboard(),
        canSendChat: useCan("sendChat"),
      }),
      { wrapper },
    );

    expect(result.current.client).toBe(client);
    expect(result.current.connection.status).toBe("idle");
    expect(result.current.participants.roster).toEqual([]);
    expect(result.current.media.local.camera.state).toBe("disabled");
    expect(result.current.chat.messages).toEqual([]);
    expect(result.current.reactions.active).toEqual([]);
    expect(result.current.whiteboard.engine.status).toBe("unsubscribed");
    expect(result.current.canSendChat).toBe(true);
  });

  it("updates a snapshot slice without a mirror adapter", () => {
    const client = createTestClient();
    const wrapper = ({ children }: PropsWithChildren) => <ChalkProvider client={client}>{children}</ChalkProvider>;
    const { result } = renderHook(() => useConnection(), { wrapper });

    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } }));

    expect(result.current.status).toBe("live");
  });

  it("joins supplied clients without taking ownership of their teardown", async () => {
    const client = createTestClient();
    const view = render(<Chalk client={client} entrance={false} defaults={{ microphone: false, camera: false }} />);

    await waitFor(() => expect(client.join).toHaveBeenCalledWith({ microphone: false, camera: false }));
    view.unmount();

    expect(client.leave).not.toHaveBeenCalled();
    expect(client.dispose).not.toHaveBeenCalled();
  });

  it("stops Entrance preview tracks when the preview is replaced and unmounted", async () => {
    const firstTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const secondTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const streams = [stream(firstTrack), stream(secondTrack)];
    const getUserMedia = vi.fn(() => Promise.resolve(streams.shift()!));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, set: () => undefined });
    const view = render(<Chalk client={createTestClient()} />);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    fireEvent.click(view.getByRole("button", { name: "Camera On" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(firstTrack.stop).toHaveBeenCalled());
    view.unmount();

    expect(secondTrack.stop).toHaveBeenCalled();
  });

  it("emits joined and left only when connection state crosses those lifecycle boundaries", () => {
    const client = createTestClient();
    const onJoined = vi.fn();
    const onLeft = vi.fn();
    render(<Chalk client={client} entrance={false} onJoined={onJoined} onLeft={onLeft} />);

    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } }));
    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "reconnecting" } }));
    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } }));
    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "leaving" } }));
    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "failed" } }));
    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "left" } }));

    expect(onJoined).toHaveBeenCalledOnce();
    expect(onLeft).toHaveBeenCalledOnce();
  });

  it("keeps pending access in the Entrance instead of rendering a second pre-live screen", () => {
    const client = createTestClient();
    const view = render(<Chalk client={client} />);
    const canvas = within(view.container);

    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "joining" } }));

    expect(canvas.getByRole("heading", { name: "Requesting access" })).toBeInTheDocument();
    expect(canvas.getByRole("status")).toHaveTextContent("Access request in progress");
    expect(canvas.queryByRole("button", { name: "Enter Space" })).not.toBeInTheDocument();
  });

  it("keeps the active Space visible under recovery UI while reconnecting", () => {
    const client = createTestClient();
    const view = render(<Chalk client={client} entrance={false} />);

    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } }));
    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "reconnecting" } }));

    expect(within(view.container).getByLabelText("Space stage")).toBeInTheDocument();
    expect(within(view.container).getByRole("alertdialog")).toHaveTextContent("Connection lost. Reconnecting");
  });

  it("keeps walk-straight-in failures out of Entrance while preserving retry", async () => {
    const client = createTestClient();
    const view = render(<Chalk client={client} entrance={false} />);

    await waitFor(() => expect(client.join).toHaveBeenCalledOnce());
    act(() => client.setSnapshot({ ...client.getSnapshot(), connection: { status: "failed", episode: null, lastError: { code: "access.unavailable", recoverable: true, message: "Access expired" } } }));
    expect(within(view.container).getByRole("status")).toHaveTextContent("Access expired");
    expect(within(view.container).queryByRole("heading", { name: "Requesting access" })).not.toBeInTheDocument();
    fireEvent.click(within(view.container).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(client.join).toHaveBeenLastCalledWith({ microphone: true, camera: true }));
  });

  it("shows a retry status when walk-straight-in join rejects before the client reports failure", async () => {
    const client = createTestClient();
    client.join = vi.fn(async () => {
      throw new Error("Access expired");
    });
    const view = render(<Chalk client={client} entrance={false} />);

    expect(view.container.firstElementChild).toHaveAttribute("data-chalk-skin", "classic");
    await waitFor(() => expect(within(view.container).getByRole("status")).toHaveTextContent("Access expired"));
    expect(within(view.container).queryByRole("heading", { name: "Enter this Space" })).not.toBeInTheDocument();
    expect(within(view.container).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(within(view.container).getByRole("main")).toHaveAttribute("data-chalk-skin", "classic");
    expect(view.container.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
  });

  it("uses the selected color scheme palette and preserves token overrides", () => {
    const client = createTestClient();
    const view = render(<Chalk client={client} theme={{ colorScheme: "dark", accent: "#7c3aed", tokens: { surface: "#15151a" } }} />);
    const root = view.container.firstElementChild;

    expect(root).toHaveAttribute("data-chalk-theme", "dark");
    expect(root).toHaveStyle({ "--chalk-canvas": "#0a0a0b", "--chalk-text": "#fbffff", "--chalk-accent": "#7c3aed", "--chalk-focus": "#7c3aed", "--chalk-surface": "#15151a" });
  });

  it("follows system color scheme changes without dropping token overrides", () => {
    let matches = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return matches;
      },
      media: "(prefers-color-scheme: dark)",
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
    }));
    const view = render(<Chalk client={createTestClient()} theme={{ colorScheme: "system", accent: "#7c3aed" }} />);
    const root = () => view.container.firstElementChild!;

    expect(root()).toHaveAttribute("data-chalk-theme", "dark");
    expect(root()).toHaveStyle({ "--chalk-canvas": "#0a0a0b", "--chalk-accent": "#7c3aed", "--chalk-focus": "#7c3aed" });

    matches = false;
    act(() => listeners.forEach((listener) => listener()));

    expect(root()).toHaveAttribute("data-chalk-theme", "light");
    expect(root()).toHaveStyle({ "--chalk-canvas": "#f7f6f2", "--chalk-accent": "#7c3aed", "--chalk-focus": "#7c3aed" });
  });

  it("resolves a system scheme before choosing the initial app palette", () => {
    let matches = true;
    vi.stubGlobal("matchMedia", () => ({ matches, media: "(prefers-color-scheme: dark)", addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));

    const darkClient = createTestClient();
    darkClient.setSnapshot({ ...darkClient.getSnapshot(), connection: { ...darkClient.getSnapshot().connection, status: "live" } });
    const darkView = render(<Chalk client={darkClient} entrance={false} theme={{ colorScheme: "system" }} />);
    expect(within(darkView.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "warm-charcoal");
    darkView.unmount();

    matches = false;
    const lightClient = createTestClient();
    lightClient.setSnapshot({ ...lightClient.getSnapshot(), connection: { ...lightClient.getSnapshot().connection, status: "live" } });
    const lightView = render(<Chalk client={lightClient} entrance={false} theme={{ colorScheme: "system" }} />);
    expect(within(lightView.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "light");
  });

  it("follows live system palette changes without overwriting explicit or user appearance", () => {
    let matches = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return matches;
      },
      media: "(prefers-color-scheme: dark)",
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
    }));

    const systemClient = createTestClient();
    systemClient.setSnapshot({ ...systemClient.getSnapshot(), connection: { ...systemClient.getSnapshot().connection, status: "live" } });
    const systemView = render(<Chalk client={systemClient} entrance={false} theme={{ colorScheme: "system" }} />);
    expect(within(systemView.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "warm-charcoal");

    matches = false;
    act(() => listeners.forEach((listener) => listener()));
    expect(within(systemView.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "light");
    matches = true;
    act(() => listeners.forEach((listener) => listener()));
    expect(within(systemView.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "warm-charcoal");
    systemView.unmount();

    const explicitClient = createTestClient();
    explicitClient.setSnapshot({ ...explicitClient.getSnapshot(), connection: { ...explicitClient.getSnapshot().connection, status: "live" } });
    const explicitView = render(<Chalk client={explicitClient} entrance={false} theme={{ colorScheme: "system", palette: "espresso-night" }} />);
    matches = false;
    act(() => listeners.forEach((listener) => listener()));
    expect(within(explicitView.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "espresso-night");
    explicitView.unmount();

    const userClient = createTestClient();
    userClient.setSnapshot({ ...userClient.getSnapshot(), connection: { ...userClient.getSnapshot().connection, status: "live" } });
    const userView = render(<Chalk client={userClient} entrance={false} theme={{ colorScheme: "system" }} features={{ settings: true }} />);
    fireEvent.click(within(userView.container).getAllByRole("button", { name: "Settings" })[0]!);
    fireEvent.click(within(document.body).getByRole("button", { name: /Appearance/ }));
    fireEvent.click(within(document.body).getByRole("button", { name: /Warm Porcelain/ }));

    matches = true;
    act(() => listeners.forEach((listener) => listener()));
    expect(within(userView.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "warm-porcelain");
  });

  it("renders incoming media requests and responds through the media controller", async () => {
    const client = createTestClient();
    const acceptRequest = vi.spyOn(client.media, "acceptRequest").mockResolvedValue();
    client.setSnapshot({
      ...client.getSnapshot(),
      connection: { ...client.getSnapshot().connection, status: "live" },
      media: {
        ...client.getSnapshot().media,
        incomingRequests: [{ requestId: "request-1", kind: "unmute", actorParticipantId: "moderator", actorDisplayName: "Ada", expiresAt: "2026-08-05T12:00:00.000Z" }],
      },
    });

    const view = render(<Chalk client={client} entrance={false} />);

    fireEvent.click(within(view.container).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(acceptRequest).toHaveBeenCalledWith("request-1"));
  });

  it("declines incoming media requests through the media controller", async () => {
    const client = createTestClient();
    const declineRequest = vi.spyOn(client.media, "declineRequest").mockResolvedValue();
    const snapshot = client.getSnapshot();
    client.setSnapshot({
      ...snapshot,
      connection: { ...snapshot.connection, status: "live" },
      media: {
        ...snapshot.media,
        incomingRequests: [{ requestId: "request-2", kind: "start_camera", actorParticipantId: "moderator", actorDisplayName: "Ada", expiresAt: "2026-08-05T12:00:00.000Z" }],
      },
    });

    const view = render(<Chalk client={client} entrance={false} />);

    fireEvent.click(within(view.container).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(declineRequest).toHaveBeenCalledWith("request-2"));
  });

  it("renders a local screen-share track in presentation mode and stops it through the controller", () => {
    screenShareSpy.mockClear();
    const client = createTestClient(createSnapshot(["publishScreen"]));
    const track = createFakeMediaStreamTrack();
    const stopScreenShare = vi.spyOn(client.media, "setScreenShareEnabled").mockResolvedValue();
    const snapshot = client.getSnapshot();
    client.setSnapshot({
      ...snapshot,
      connection: { ...snapshot.connection, status: "live" },
      media: {
        ...snapshot.media,
        local: { ...snapshot.media.local, screen: { source: "screen", state: "enabled", track } },
        screenShare: { source: "screen", state: "enabled", track },
      },
    });

    const view = render(<Chalk client={client} entrance={false} layout="grid" />);

    expect(within(view.container).getByRole("button", { name: "Layout: Presentation" })).toBeInTheDocument();
    expect(screenShareSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ screenShareTrack: track, sharedByName: "You", showThumbnails: false }));
    fireEvent.click(within(view.container).getByRole("button", { name: "Stop active share" }));
    expect(stopScreenShare).toHaveBeenCalledWith(false);

    act(() =>
      client.setSnapshot({
        ...client.getSnapshot(),
        media: {
          ...client.getSnapshot().media,
          local: { ...client.getSnapshot().media.local, screen: { source: "screen", state: "disabled", track: null } },
          screenShare: { source: "screen", state: "disabled", track: null },
        },
      }),
    );
    expect(within(view.container).getByRole("button", { name: "Layout: Grid" })).toBeInTheDocument();
  });

  it("promotes a remote screen-share track and stops it through the participant controller", () => {
    screenShareSpy.mockClear();
    const client = createTestClient();
    const track = createFakeMediaStreamTrack();
    const stopScreenShare = vi.spyOn(client.participants, "stopScreenShare").mockResolvedValue();
    const snapshot = client.getSnapshot();
    client.setSnapshot({
      ...snapshot,
      connection: { ...snapshot.connection, status: "live" },
      participants: {
        ...snapshot.participants,
        roster: [{ participantId: "grace", displayName: "Grace", role: "member", eligibleRoles: ["member"], capabilities: [], handRaised: false, presence: { state: "connected", speaking: false, activeSpeaker: false }, media: { microphone: "inactive", camera: "inactive", screenShare: "active" } }],
      },
      media: {
        ...snapshot.media,
        remote: [{ participantId: "grace", source: "screen", publicationId: "grace-screen", track }],
      },
    });

    const view = render(<Chalk client={client} entrance={false} layout="grid" />);

    expect(within(view.container).getByRole("button", { name: "Layout: Presentation" })).toBeInTheDocument();
    expect(screenShareSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ screenShareTrack: track, sharedByName: "Grace", showThumbnails: false }));
    fireEvent.click(within(view.container).getByRole("button", { name: "Stop active share" }));
    expect(stopScreenShare).toHaveBeenCalledWith("grace");

    act(() => client.setSnapshot({ ...client.getSnapshot(), media: { ...client.getSnapshot().media, remote: [] } }));
    expect(within(view.container).getByRole("button", { name: "Layout: Grid" })).toBeInTheDocument();
  });

  it("shows directed media actions when the caller has the canonical request capability", () => {
    const client = createTestClient(createSnapshot(["requestMediaOthers"]));
    const requestMedia = vi.spyOn(client.participants, "requestMedia").mockResolvedValue({ status: "delivered", requestId: "request-2" });
    const snapshot = client.getSnapshot();
    client.setSnapshot({
      ...snapshot,
      connection: { ...snapshot.connection, status: "live" },
      participants: {
        ...snapshot.participants,
        roster: [{ participantId: "grace", displayName: "Grace", role: "member", eligibleRoles: ["member"], capabilities: [], handRaised: false, presence: { state: "connected", speaking: false, activeSpeaker: false }, media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" } }],
      },
    });

    const view = render(<Chalk client={client} entrance={false} />);
    fireEvent.click(within(view.container).getAllByRole("button", { name: "People" })[0]!);
    fireEvent.click(within(view.container).getByRole("button", { name: "Options for Grace" }));
    fireEvent.click(within(view.container).getByRole("button", { name: "Ask to unmute" }));

    expect(requestMedia).toHaveBeenCalledWith("grace", "microphone");

    fireEvent.click(within(view.container).getByRole("button", { name: "Options for Grace" }));
    fireEvent.click(within(view.container).getByRole("button", { name: "Ask to start camera" }));
    expect(requestMedia).toHaveBeenCalledWith("grace", "camera");
  });

  it("uses the single theme prop for initial skin, palette, and texture", () => {
    const client = createTestClient();
    client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } });
    const view = render(<Chalk client={client} entrance={false} features={{ settings: true }} theme={{ skin: "chalk", palette: "oled-signal", texture: "slate" }} />);

    expect(view.container.firstElementChild).toHaveAttribute("data-chalk-skin", "chalk");
    expect(within(view.container).getByRole("main")).toHaveAttribute("data-chalk-skin", "chalk");
    expect(within(view.container).getByRole("main").querySelector("svg[data-chalk-chrome='true']")).toBeInTheDocument();
    expect(within(view.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "oled-signal");
    expect(within(view.container).getByRole("main")).toHaveAttribute("data-chalk-texture", "slate");

    fireEvent.click(within(view.container).getAllByRole("button", { name: "Settings" })[0]!);
    fireEvent.click(within(document.body).getByRole("button", { name: /Appearance/ }));
    fireEvent.click(within(document.body).getByRole("button", { name: /Classic/ }));
    fireEvent.click(within(document.body).getByRole("button", { name: /Warm Porcelain/ }));
    fireEvent.click(within(document.body).getByRole("button", { name: "Use Paper Grain texture" }));

    expect(within(view.container).getByRole("main")).toHaveAttribute("data-chalk-skin", "classic");
    expect(within(view.container).getByRole("main").querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
    expect(within(view.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "warm-porcelain");
    expect(within(view.container).getByRole("main")).toHaveAttribute("data-chalk-texture", "paper");
  });

  it("routes a custom raw chat file picker through the live ChatPanel upload path", async () => {
    const client = createTestClient();
    const snapshot = client.getSnapshot();
    client.setSnapshot({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
    const rawFile: ChatUploadFile = { fileName: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello").buffer as ArrayBuffer };
    const pickChatFiles = vi.fn(async () => [rawFile] as const);
    const attachment = { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain" as const, byteLength: 5 };
    const upload = vi.spyOn(client.chat.files, "upload").mockResolvedValue(attachment);
    const view = render(<Chalk client={client} entrance={false} pickChatFiles={pickChatFiles} />);

    fireEvent.click(within(view.container).getAllByRole("button", { name: "Chat" })[0]!);
    fireEvent.click(within(view.container).getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(pickChatFiles).toHaveBeenCalledOnce());
    expect(within(view.container).queryByLabelText("Choose attachments")).not.toBeInTheDocument();

    fireEvent.click(within(view.container).getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(upload).toHaveBeenCalledWith(rawFile));
  });

  it("keeps an owned client stable across inline getAccess callbacks and rebuilds it when the Space changes", async () => {
    const firstClient = createTestClient();
    const secondClient = createTestClient();
    createSpaceClientSpy.mockReturnValueOnce(firstClient).mockReturnValueOnce(secondClient);
    const firstAccess = vi.fn(async () => Promise.reject(new Error("stale callback")));
    const latestAccess = vi.fn(async () => Promise.reject(new Error("latest callback")));
    const view = render(<Chalk space="design" getAccess={firstAccess} />);
    const firstFactoryOptions = createSpaceClientSpy.mock.calls[0]?.[0] as { readonly getAccess: (context: { readonly space: string; readonly reason: "refresh" }) => Promise<unknown> };

    view.rerender(<Chalk space="design" getAccess={latestAccess} />);
    expect(createSpaceClientSpy).toHaveBeenCalledOnce();
    await expect(firstFactoryOptions.getAccess({ space: "design", reason: "refresh" })).rejects.toThrow("latest callback");
    expect(firstAccess).not.toHaveBeenCalled();
    expect(latestAccess).toHaveBeenCalledOnce();

    view.rerender(<Chalk space="planning" getAccess={latestAccess} />);
    expect(createSpaceClientSpy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(firstClient.leave).toHaveBeenCalledOnce());
    await waitFor(() => expect(firstClient.dispose).toHaveBeenCalledOnce());
  });

  it("opens the controlled settings dialog only when the turnkey settings feature is enabled", () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } });
    const view = render(<Chalk client={client} features={{ settings: true }} />);

    fireEvent.click(within(view.container).getAllByRole("button", { name: "Settings" })[0]!);
    expect(document.querySelector('[role="dialog"]')).toBeInTheDocument();

    view.unmount();
    const disabledView = render(<Chalk client={client} features={{ settings: false }} />);
    expect(within(disabledView.container).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("opens diagnostics from the live Space when the embedding app provides the action", () => {
    const client = createTestClient();
    const onOpenDiagnostics = vi.fn();
    client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } });
    const view = render(<Chalk client={client} onOpenDiagnostics={onOpenDiagnostics} />);

    fireEvent.click(within(view.container).getAllByRole("button", { name: "Diagnostics" })[0]!);

    expect(onOpenDiagnostics).toHaveBeenCalledOnce();
  });

  it("clears the settings sidebar when turnkey Settings closes", async () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } });
    const view = render(<Chalk client={client} features={{ settings: true }} />);

    fireEvent.click(within(view.container).getAllByRole("button", { name: "Settings" })[0]!);
    expect(view.container.querySelector("[data-chalk-drawer]")).toBeInTheDocument();
    fireEvent.click(document.querySelector('[role="dialog"] button[aria-label="Close settings"]')!);

    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeInTheDocument();
      expect(view.container.querySelector("[data-chalk-drawer]")).not.toBeInTheDocument();
    });
  });

  it("applies the Settings layout selector to the live stage", () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } });
    const view = render(<Chalk client={client} features={{ settings: true }} />);

    fireEvent.click(within(view.container).getAllByRole("button", { name: "Settings" })[0]!);
    fireEvent.click(within(document.body).getByRole("button", { name: /Appearance/ }));
    fireEvent.click(within(document.body).getByRole("button", { name: "Grid" }));

    expect(view.container.querySelector('button[aria-label="Layout: Grid"]')).not.toBeNull();
  });

  it("keeps a texture-only theme following system palette changes", () => {
    let matches = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return matches;
      },
      media: "(prefers-color-scheme: dark)",
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    const client = createTestClient();
    client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } });
    const view = render(<Chalk client={client} entrance={false} theme={{ colorScheme: "system", texture: "paper" }} />);

    expect(within(view.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "warm-charcoal");
    matches = false;
    act(() => listeners.forEach((listener) => listener()));

    expect(within(view.container).getByRole("main")).toHaveAttribute("data-chalk-palette", "light");
  });

  it("does not render a Chat composer without sendChat", () => {
    const client = createTestClient(createSnapshot([]));
    client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } });
    const view = render(<Chalk client={client} />);

    expect(within(view.container).queryByRole("button", { name: "Chat" })).not.toBeInTheDocument();
  });

  it("presents and hides the shared whiteboard from the Space snapshot", async () => {
    const transport = createWhiteboardTransport();
    const initial = createSnapshot(["drawWhiteboard"]);
    const client = createTestClient(
      {
        ...initial,
        connection: { ...initial.connection, status: "live" },
        whiteboard: { open: true, engine: { status: "ready", sceneId: "scene-1", revision: "4", presenting: false, error: null } },
      },
      transport,
    );
    const view = render(<Chalk client={client} entrance={false} layout="presentation" />);

    await waitFor(() => expect(transport.startSceneSubscription).toHaveBeenCalledOnce());
    fireEvent.click(within(view.container).getAllByRole("button", { name: /Whiteboard|Board/ })[0]!);
    expect(transport.setPresentation).toHaveBeenCalledWith(true);

    act(() => client.setSnapshot({ ...client.getSnapshot(), whiteboard: { ...client.getSnapshot().whiteboard, engine: { ...client.getSnapshot().whiteboard.engine, presenting: true } } }));
    expect(within(view.container).getByRole("region", { name: "Shared whiteboard" })).toBeInTheDocument();

    fireEvent.click(within(view.container).getAllByRole("button", { name: /Whiteboard|Board/ })[0]!);
    expect(transport.setPresentation).toHaveBeenLastCalledWith(false);

    act(() => client.setSnapshot({ ...client.getSnapshot(), whiteboard: { ...client.getSnapshot().whiteboard, engine: { ...client.getSnapshot().whiteboard.engine, presenting: false } } }));
    expect(within(view.container).queryByRole("region", { name: "Shared whiteboard" })).not.toBeInTheDocument();
    expect(transport.startSceneSubscription).toHaveBeenCalledOnce();
    expect(transport.stopSceneSubscription).not.toHaveBeenCalled();
  });

  it("gates the separately confirmed End Episode action on the endEpisode capability", () => {
    const authorized = createTestClient(createSnapshot(["sendChat", "endEpisode"]));
    authorized.setSnapshot({ ...authorized.getSnapshot(), connection: { ...authorized.getSnapshot().connection, status: "live" } });
    const view = render(<Chalk client={authorized} />);

    fireEvent.click(within(view.container).getAllByRole("button", { name: "Leave" })[0]!);
    fireEvent.click(within(view.container).getByRole("button", { name: "End Episode for everyone" }));
    fireEvent.click(within(view.container).getByRole("button", { name: "End Episode" }));
    expect(authorized.endEpisode).toHaveBeenCalledOnce();

    view.unmount();
    const unauthorized = createTestClient(createSnapshot(["sendChat"]));
    unauthorized.setSnapshot({ ...unauthorized.getSnapshot(), connection: { ...unauthorized.getSnapshot().connection, status: "live" } });
    const unauthorizedView = render(<Chalk client={unauthorized} />);
    fireEvent.click(within(unauthorizedView.container).getAllByRole("button", { name: "Leave" })[0]!);
    expect(within(unauthorizedView.container).queryByRole("button", { name: "End Episode for everyone" })).not.toBeInTheDocument();
  });
});

function createTestClient(initialSnapshot = createSnapshot(), whiteboardTransport: ChalkWhiteboardV1Transport | null = null): TestClient {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  const unavailable = vi.fn(async () => undefined);
  const client = {
    media: {
      setMicrophoneEnabled: unavailable,
      setCameraEnabled: unavailable,
      setScreenShareEnabled: unavailable,
      selectMicrophone: unavailable,
      selectCamera: unavailable,
      selectSpeaker: unavailable,
      acceptRequest: unavailable,
      declineRequest: unavailable,
    },
    chat: {
      files: { upload: unavailable, url: () => "" },
      send: unavailable,
      loadOlder: unavailable,
      markRead: unavailable,
    },
    participants: {
      assignRole: unavailable,
      mute: unavailable,
      stopVideo: unavailable,
      stopScreenShare: unavailable,
      requestMedia: unavailable,
      remove: unavailable,
      admit: unavailable,
      deny: unavailable,
      raiseHand: unavailable,
      lowerHand: unavailable,
      renameSelf: unavailable,
    },
    reactions: { send: unavailable },
    whiteboard: { transport: () => whiteboardTransport },
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    dispose: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    endEpisode: unavailable,
    extendEpisode: unavailable,
    on: () => () => undefined,
  } as unknown as SpaceClient;

  return Object.assign(client, {
    setSnapshot: (nextSnapshot: SpaceSnapshot) => {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
  });
}

function createWhiteboardTransport(): ChalkWhiteboardV1Transport {
  const transport: ChalkWhiteboardV1Transport = {
    startSceneSubscription: vi.fn(async () => undefined),
    stopSceneSubscription: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    submitUpdate: vi.fn(),
    sendCursor: vi.fn(),
    requestSnapshot: vi.fn(),
    clear: vi.fn(),
    setDrawPermission: vi.fn(),
    setPresentation: vi.fn(async function (this: ChalkWhiteboardV1Transport) {
      if (this !== transport) throw new Error("Whiteboard transport receiver was lost");
    }),
    files: { initiateUpload: vi.fn(), finalizeUpload: vi.fn(), getDownloadUrl: vi.fn() },
  };
  return transport;
}

function createSnapshot(capabilities: readonly Capability[] = ["sendChat"]): SpaceSnapshot {
  return {
    connection: { status: "idle", episode: null, lastError: null },
    self: { participantId: null, displayName: null, role: null, capabilities, handRaised: false, can: (capability) => capabilities.includes(capability) },
    participants: { roster: [], admissionQueue: [] },
    media: {
      devices: { microphones: [], cameras: [], speakers: [] },
      selection: { microphone: null, camera: null, speaker: null },
      local: {
        microphone: { source: "microphone", state: "disabled", track: null },
        camera: { source: "camera", state: "disabled", track: null },
        screen: { source: "screen", state: "disabled", track: null },
      },
      remote: [],
      screenShare: { source: "screen", state: "disabled", track: null },
      incomingRequests: [],
    },
    chat: { status: "idle", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false }, lastError: null },
    reactions: { active: [] },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, presenting: false, error: null } },
  };
}

function stream(track: MediaStreamTrack): MediaStream {
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}
