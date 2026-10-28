import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectionAccessRequest } from "../connection/dependencies";
import { CloudflareSFUError } from "../media";
import { getAccessRefreshState } from "../server/access-refresh";
import { createChalkServerClient } from "../server/client";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

it("does not replace another live tab's same-generation media after an obsolete startup is rejected", async () => {
  let currentBinding = "connection-1";
  let binding = 1;
  const initial = opaqueAccessGrant("1", "1", currentBinding);
  const retained = getAccessRefreshState(initial);
  const server = createChalkServerClient({
    apiKey: "fixture",
    tenantId: "tenant-1",
    apiBaseURL: "https://api.test",
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.participant_generation).toBe(1);
      if (request.replace_media_connection) currentBinding = `connection-${++binding}`;
      return Response.json(opaqueAccessGrant(binding, String(binding), currentBinding), { status: 201 });
    },
  });
  const platformA = createCoreTestPlatform();
  const platformB = createCoreTestPlatform();
  platformA.dependencies.clock.now = Date.now;
  platformB.dependencies.clock.now = Date.now;
  let release: () => void = () => {};
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = vi.fn();
  let accesses = 0;
  const getAccessA = vi.fn(async (request: ConnectionAccessRequest) => (++accesses === 1 ? initial : server.participants.issueAccess("space-1", "episode-1", "participant-1", retained, request)));
  const a = createSpaceClientForPlatform(
    { space: "test", getAccess: getAccessA },
    {
      ...platformA,
      dependencies: {
        ...platformA.dependencies,
        cancelPendingAdmission: async () => false,
        createMediaClient: (input) => {
          const media = platformA.dependencies.createMediaClient(input);
          const connectionId = input.access.media.clientPayload.connectionId;
          return {
            ...media,
            start: async (stream) => {
              if (connectionId === "connection-1") {
                started();
                await stalled;
              }
              if (connectionId !== currentBinding) throw new CloudflareSFUError("obsolete media access", "signaling_failed", { status: 403 });
              await media.start(stream);
            },
          };
        },
      },
    },
  );
  let b: ReturnType<typeof createSpaceClientForPlatform> | undefined;
  const joining = a.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
  try {
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const liveGrant = await server.participants.issueAccess("space-1", "episode-1", "participant-1", retained, { replaceMediaConnection: true });
    b = createSpaceClientForPlatform({ space: "test", getAccess: async () => liveGrant }, platformB);
    await b.join({ microphone: false, camera: false });
    expect(b.getSnapshot().connection.status).toBe("live");
    expect(currentBinding).toBe("connection-2");
    release();
    const failure = await joining;
    expect(currentBinding).toBe("connection-2");
    expect(failure).toMatchObject({ code: "access.invalid", recoverable: false, message: expect.stringContaining("Rejoin explicitly") });
    expect(a.getSnapshot().connection).toMatchObject({ status: "failed", lastError: { code: "access.invalid", recoverable: false } });
    expect(getAccessA.mock.calls.map(([request]) => request.reason)).toEqual(["join"]);
    expect(b.getSnapshot().connection.status).toBe("live");
  } finally {
    release();
    await joining;
    a.dispose();
    b?.dispose();
  }
});
