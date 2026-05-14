// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePwaLifecycle } from "../../hooks/ui/usePwaLifecycle";

describe("usePwaLifecycle", () => {
  beforeEach(() => {
    const storage = (() => {
      const values = new Map<string, string>();
      return {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => Array.from(values.keys())[index] ?? null,
        get length() {
          return values.size;
        },
        removeItem: (key: string) => {
          values.delete(key);
        },
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      } satisfies Storage;
    })();

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tracks waiting service workers and reloads into updates", async () => {
    const waitingWorker = {
      postMessage: vi.fn((message: unknown, transfer?: Transferable[]) => {
        const payload = message as { type?: string };
        if (payload.type !== "GET_BUILD_META") {
          return;
        }

        const port = transfer?.[0] as MessagePort | undefined;
        port?.postMessage({
          commitHash: "abc1234",
          version: "0.1.0",
        });
      }),
    } as unknown as ServiceWorker;

    const registration = {
      addEventListener: vi.fn(),
      installing: null,
      removeEventListener: vi.fn(),
      update: vi.fn(async () => undefined),
      waiting: waitingWorker,
    } as unknown as ServiceWorkerRegistration;

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        controller: {},
        register: vi.fn(async () => registration),
        removeEventListener: vi.fn(),
      } satisfies Partial<ServiceWorkerContainer>,
    });

    const { result } = renderHook(() =>
      usePwaLifecycle({
        serviceWorkerPath: "/sw.js",
        versionTag: "commit-123",
      }),
    );

    await waitFor(() => {
      expect(result.current.updateAvailable).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.waitingBuildMeta).toEqual({
        commitHash: "abc1234",
        version: "0.1.0",
      });
    });

    act(() => {
      result.current.reloadToUpdate();
    });

    expect(waitingWorker.postMessage).toHaveBeenCalledWith({
      type: "SKIP_WAITING",
    });

    act(() => {
      result.current.dismissUpdate();
    });

    expect(result.current.updateAvailable).toBe(false);
  });

  it("persists prompt dismissal state", () => {
    const { result } = renderHook(() =>
      usePwaLifecycle({
        enabled: false,
      }),
    );

    act(() => {
      result.current.setDismissed(true);
    });

    expect(result.current.dismissed).toBe(true);
    expect(window.localStorage.getItem("chalk-pwa-install-dismissed")).toBe("1");

    act(() => {
      result.current.setDismissed(false);
    });

    expect(result.current.dismissed).toBe(false);
    expect(window.localStorage.getItem("chalk-pwa-install-dismissed")).toBeNull();
  });
});
