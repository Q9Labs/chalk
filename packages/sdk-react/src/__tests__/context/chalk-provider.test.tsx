import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

const createdSessions: Array<Record<string, unknown>> = [];
const mockChalkSession = vi.fn(function () {
  const session = {
    on: vi.fn(() => () => {}),
    configureIncident: vi.fn(),
    dispose: vi.fn(),
    room: {
      getRoom: () => null,
    },
  };
  createdSessions.push(session);
  return session;
});

vi.mock("@q9labs/chalk-core", () => ({
  ChalkSession: mockChalkSession,
  chalkDebugCollector: {
    registerSection: vi.fn(() => () => {}),
  },
}));

vi.mock("@cloudflare/realtimekit-react", () => ({
  RealtimeKitProvider: ({ children }: { children: ReactNode }) => children,
}));

describe("ChalkProvider", () => {
  beforeEach(() => {
    createdSessions.length = 0;
    mockChalkSession.mockClear();
  });

  it("reuses the same session for the same cache key and recreates it when the key changes", async () => {
    const { ChalkProvider, useSession } = await import("../../context/chalk-provider");
    const apiUrl = `https://api.chalk.local/${Date.now()}`;

    let observedSession: unknown = null;

    function SessionProbe() {
      observedSession = useSession();
      return null;
    }

    const firstRender = render(
      <ChalkProvider apiUrl={apiUrl} sessionCacheKey="room:a">
        <SessionProbe />
      </ChalkProvider>,
    );

    const firstSession = observedSession;
    expect(mockChalkSession).toHaveBeenCalledTimes(1);
    expect(firstSession).toBe(createdSessions[0]);

    firstRender.unmount();

    const secondRender = render(
      <ChalkProvider apiUrl={apiUrl} sessionCacheKey="room:a">
        <SessionProbe />
      </ChalkProvider>,
    );

    expect(observedSession).toBe(firstSession);
    expect(mockChalkSession).toHaveBeenCalledTimes(1);

    secondRender.rerender(
      <ChalkProvider apiUrl={apiUrl} sessionCacheKey="room:b">
        <SessionProbe />
      </ChalkProvider>,
    );

    expect(mockChalkSession).toHaveBeenCalledTimes(2);
    expect(observedSession).toBe(createdSessions[1]);
    expect(observedSession).not.toBe(firstSession);
    expect((createdSessions[0] as any).dispose).toHaveBeenCalledTimes(1);
  });
});
