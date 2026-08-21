// @vitest-environment happy-dom

import type { IncomingMediaRequest } from "@q9labsai/chalk-client";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMediaRequestDialogState } from "./media-request-dialog-state";

afterEach(() => {
  vi.useRealTimers();
});

function request(overrides: Partial<IncomingMediaRequest> = {}): IncomingMediaRequest {
  return {
    requestId: "request-1",
    kind: "unmute",
    actorParticipantId: "participant-1",
    actorDisplayName: "Ari",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
  };
}

describe("useMediaRequestDialogState", () => {
  it("reports the expiry, tracks an action while it is pending, and clears it after success", async () => {
    let resolveAllow: (() => void) | undefined;
    const allow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAllow = resolve;
        }),
    );
    const onActionError = vi.fn();
    const { result } = renderHook(() => useMediaRequestDialogState({ request: request(), onDecline: vi.fn(), onAllow: allow, onActionError }));

    expect(result.current.isExpired).toBe(false);
    expect(result.current.expiryLabel).toMatch(/^Expires in \d+ min$/u);

    act(() => result.current.runAction("allow"));
    expect(result.current.pendingAction).toBe("allow");

    await waitFor(() => expect(allow).toHaveBeenCalledOnce());

    await act(async () => {
      resolveAllow?.();
    });
    await waitFor(() => expect(result.current.pendingAction).toBeNull());

    expect(result.current.errorMessage).toBeNull();
    expect(onActionError).toHaveBeenLastCalledWith(null, "allow");
  });

  it("surfaces action failures and identifies the failed action", async () => {
    const onDecline = vi.fn().mockRejectedValue(new Error("Request was rejected"));
    const onActionError = vi.fn();
    const { result } = renderHook(() => useMediaRequestDialogState({ request: request(), onDecline, onAllow: vi.fn(), onActionError }));

    act(() => result.current.runAction("decline"));

    await waitFor(() => expect(result.current.errorMessage).toBe("Request was rejected"));
    expect(onDecline).toHaveBeenCalledOnce();
    expect(onActionError).toHaveBeenCalledWith("Request was rejected", "decline");
    expect(result.current.pendingAction).toBeNull();
  });

  it("expires requests and ignores actions after expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const onAllow = vi.fn();
    const onDecline = vi.fn();
    const { result } = renderHook(() =>
      useMediaRequestDialogState({
        request: request({ expiresAt: "2026-08-21T12:00:01.000Z" }),
        onDecline,
        onAllow,
      }),
    );

    act(() => vi.advanceTimersByTime(1_001));

    expect(result.current.isExpired).toBe(true);
    expect(result.current.expiryLabel).toBe("This request has expired.");
    act(() => result.current.runAction("allow"));
    act(() => result.current.runAction("decline"));
    expect(onAllow).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
  });
});
