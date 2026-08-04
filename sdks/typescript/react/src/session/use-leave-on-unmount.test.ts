// @vitest-environment happy-dom

import type { SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import { SpaceClientAdapter, type SpaceClientStore } from "../client-compat";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useLeaveOnUnmount } from "./use-leave-on-unmount";

describe("useLeaveOnUnmount", () => {
  it("leaves the latest session once when the component unmounts", () => {
    const firstLeave = vi.fn(() => Promise.resolve());
    const secondLeave = vi.fn(() => Promise.resolve());
    const firstSession = { leave: firstLeave } satisfies Pick<SpaceClientStore, "leave">;
    const secondSession = { leave: secondLeave } satisfies Pick<SpaceClientStore, "leave">;
    const onUnmount = vi.fn();
    const { rerender, unmount } = renderHook(({ session }) => useLeaveOnUnmount(session, onUnmount), { initialProps: { session: firstSession } });

    rerender({ session: secondSession });
    unmount();

    expect(onUnmount).toHaveBeenCalledOnce();
    expect(firstLeave).not.toHaveBeenCalled();
    expect(secondLeave).toHaveBeenCalledOnce();
  });

  it("disposes an adapted canonical client after its leave completes", async () => {
    const { dispose, leave, store } = createCanonicalAdapter();
    const { unmount } = renderHook(() => useLeaveOnUnmount(store, () => undefined));

    unmount();

    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(leave).toHaveBeenCalledOnce();
    expect(leave.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });
});

function createCanonicalAdapter(): { readonly dispose: ReturnType<typeof vi.fn>; readonly leave: ReturnType<typeof vi.fn>; readonly store: SpaceClientAdapter } {
  const leave = vi.fn(() => Promise.resolve());
  const dispose = vi.fn();
  const snapshot = {
    connection: { status: "idle", lastError: null },
    self: { participantId: null, capabilities: [] },
    participants: { roster: [], admissionQueue: [] },
    media: { local: {}, remote: [], incomingRequests: [] },
    reactions: { active: [] },
    chat: {},
  } as unknown as SpaceSnapshot;
  const client = {
    media: {},
    chat: { files: { upload: unavailable, url: () => "" } },
    whiteboard: { transport: () => null },
    leave,
    dispose,
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  } as unknown as SpaceClient;

  return { leave, dispose, store: new SpaceClientAdapter(client) };
}

async function unavailable(): Promise<never> {
  throw new Error("This command is not configured for the test");
}
