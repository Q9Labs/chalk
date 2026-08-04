// @vitest-environment happy-dom
import type { SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const testingLibrary = createRequire(import.meta.url)(join(process.cwd(), "../react/node_modules", "@testing-library/react")) as {
  readonly act: (callback: () => void | Promise<void>) => void | Promise<void>;
  readonly cleanup: () => void;
  readonly render: (element: ReactNode) => { readonly container: HTMLElement; readonly unmount: () => void; readonly rerender: (element: ReactNode) => void };
};
const { act, cleanup, render } = testingLibrary;

const nativeClientFactory = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { readonly children?: ReactNode }) => children,
  Text: ({ children }: { readonly children?: ReactNode }) => children,
  Pressable: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("../space-client/create-native-space-client", () => ({ createNativeSpaceClient: nativeClientFactory }));
vi.mock("./SpaceView", () => ({ SpaceView: () => <div data-testid="space" /> }));
vi.mock("./Entrance", () => ({ Entrance: () => <div data-testid="entrance" /> }));

import { Chalk } from "./Chalk";

afterEach(() => {
  cleanup();
  nativeClientFactory.mockReset();
});

describe("Chalk", () => {
  it("fires joined and left only for the specified connection transitions", () => {
    const client = createClient("joining");
    const onJoined = vi.fn();
    const onLeft = vi.fn();
    render(<Chalk client={client.client} entrance={false} onJoined={onJoined} onLeft={onLeft} />);

    act(() => client.setStatus("live"));
    act(() => client.setStatus("reconnecting"));
    act(() => client.setStatus("live"));
    act(() => client.setStatus("left"));

    expect(onJoined).toHaveBeenCalledTimes(1);
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it("does not fire joined for an already-live supplied client", () => {
    const client = createClient("live");
    const onJoined = vi.fn();
    render(<Chalk client={client.client} entrance={false} onJoined={onJoined} />);

    expect(onJoined).not.toHaveBeenCalled();
  });

  it("forwards canonical client events and cleans their subscriptions up", () => {
    const client = createClient("live");
    const handlers = new Map<string, (event: unknown) => void>();
    const unsubscribe = vi.fn();
    const eventClient = client.client as { on: (event: string, handler: unknown) => () => void };
    eventClient.on = vi.fn((event, handler) => {
      handlers.set(event, handler as (event: unknown) => void);
      return unsubscribe;
    });
    const onError = vi.fn();
    const view = render(<Chalk client={client.client} onEpisodeEnded={vi.fn()} onError={onError} onParticipantJoined={vi.fn()} onParticipantLeft={vi.fn()} onScreenShareStarted={vi.fn()} onScreenShareStopped={vi.fn()} />);

    const error = { error: { code: "client.internal_error", message: "test", recoverable: true } };
    handlers.get("error")?.(error);
    expect(onError).toHaveBeenCalledWith(error);

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(6);
  });

  it("leaves an owned client before disposing it on unmount", async () => {
    const client = createClient("joining");
    let resolveLeave: (() => void) | undefined;
    client.client.leave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLeave = resolve;
        }),
    );
    nativeClientFactory.mockReturnValue(client.client);

    const view = render(<Chalk entrance={false} getAccess={vi.fn()} space="space-1" />);
    view.unmount();

    expect(client.client.leave).toHaveBeenCalledTimes(1);
    expect(client.client.dispose).not.toHaveBeenCalled();
    await act(async () => resolveLeave?.());
    expect(client.client.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps an owned SpaceClient when getAccess changes identity and uses the latest callback", async () => {
    const client = createClient("idle");
    const firstAccess = vi.fn(async () => ({ token: "first" }));
    const latestAccess = vi.fn(async () => ({ token: "latest" }));
    nativeClientFactory.mockReturnValue(client.client);

    const view = render(<Chalk entrance getAccess={firstAccess} space="space-1" />);
    view.rerender(<Chalk entrance getAccess={latestAccess} space="space-1" />);

    expect(nativeClientFactory).toHaveBeenCalledTimes(1);
    const access = nativeClientFactory.mock.calls[0]?.[0].getAccess as (input: unknown) => Promise<unknown>;
    await expect(access({})).resolves.toEqual({ token: "latest" });
    expect(firstAccess).not.toHaveBeenCalled();
    expect(latestAccess).toHaveBeenCalledTimes(1);
  });

  it("omits an absent display name when joining without Entrance", async () => {
    const client = createClient("idle");
    render(<Chalk client={client.client} entrance={false} />);

    await act(async () => undefined);
    expect(client.client.join).toHaveBeenCalledWith({ microphone: true, camera: true });
  });

  it("retries automatic join when an owned client is replaced for a new Space", async () => {
    const first = createClient("idle");
    const replacement = createClient("idle");
    nativeClientFactory.mockReturnValueOnce(first.client).mockReturnValueOnce(replacement.client);

    const view = render(<Chalk entrance={false} getAccess={vi.fn()} space="space-1" />);
    await act(async () => undefined);
    expect(first.client.join).toHaveBeenCalledWith({ microphone: true, camera: true });

    view.rerender(<Chalk entrance={false} getAccess={vi.fn()} space="space-2" />);
    await act(async () => undefined);

    expect(nativeClientFactory).toHaveBeenCalledTimes(2);
    expect(replacement.client.join).toHaveBeenCalledWith({ microphone: true, camera: true });
  });

  it("treats a replacement client's initial failure as an Entrance failure", () => {
    const first = createClient("live");
    const replacement = createClient("failed");
    nativeClientFactory.mockReturnValueOnce(first.client).mockReturnValueOnce(replacement.client);

    const view = render(<Chalk entrance getAccess={vi.fn()} space="space-1" />);
    view.rerender(<Chalk entrance getAccess={vi.fn()} space="space-2" />);

    expect(view.container.querySelector('[data-testid="entrance"]')).not.toBeNull();
  });

  it("keeps the active Space visible during reconnecting and never after left", () => {
    const client = createClient("live");
    const view = render(<Chalk client={client.client} />);

    expect(view.container.querySelector('[data-testid="space"]')).not.toBeNull();
    act(() => client.setStatus("reconnecting"));
    expect(view.container.querySelector('[data-testid="space"]')).not.toBeNull();
    act(() => client.setStatus("left"));
    expect(view.container.querySelector('[data-testid="space"]')).toBeNull();
    expect(view.container.textContent).toContain("You have left this Space.");
  });
});

function createClient(status: SpaceSnapshot["connection"]["status"]): { readonly client: SpaceClient; readonly setStatus: (nextStatus: SpaceSnapshot["connection"]["status"]) => void } {
  let snapshot = createSnapshot(status);
  const listeners = new Set<() => void>();
  const client = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    on: vi.fn(() => () => undefined),
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    dispose: vi.fn(),
    endEpisode: vi.fn(async () => undefined),
    media: {},
    chat: {},
    participants: {},
    reactions: {},
    whiteboard: {},
  } as unknown as SpaceClient;
  return {
    client,
    setStatus(nextStatus) {
      snapshot = { ...snapshot, connection: { ...snapshot.connection, status: nextStatus } };
      listeners.forEach((listener) => listener());
    },
  };
}

function createSnapshot(status: SpaceSnapshot["connection"]["status"]): SpaceSnapshot {
  const capabilities = [] as const;
  return {
    connection: { status, episode: null, lastError: null },
    self: { participantId: null, displayName: null, role: null, capabilities, handRaised: false, can: () => false },
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
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, error: null } },
  };
}
