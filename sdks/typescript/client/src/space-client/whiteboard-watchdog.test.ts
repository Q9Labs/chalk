import { describe, expect, it, vi } from "vitest";
import type { ConnectionWhiteboardFactoryInput } from "../connection/dependencies";
import type { DiagnosticEventDraft } from "@q9labsai/diagnostics-contracts";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

const replacement = { reason: "slow_heartbeat", roundTripsMs: [2_200, 2_100], outstandingAgesMs: [], backoffMs: 1_000 } as const;

describe("SpaceClient whiteboard watchdog diagnostics", () => {
  it.each([true, false])("exports exactly one bounded diagnostic when credential enabled=%s", async (enabled) => {
    let input: ConnectionWhiteboardFactoryInput | undefined;
    const batches: DiagnosticEventDraft[][] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body: { events: DiagnosticEventDraft[] } = JSON.parse(String(init?.body));
      batches.push(body.events);
      return new Response(JSON.stringify({ accepted: body.events.map((event, index) => ({ eventId: event.eventId, cursor: index + 1 })), duplicates: [], conflicts: [] }), { status: 202 });
    };
    const platform = createCoreTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "test", getAccess: async () => opaqueAccessGrant(enabled ? 1 : "no-diagnostics") },
      {
        ...platform,
        fetch,
        dependencies: {
          ...platform.dependencies,
          createWhiteboardClient: (options) => {
            input = options;
            return null;
          },
        },
      },
    );
    try {
      await client.join({ microphone: false, camera: false });
      input?.onWatchdogReplacement?.(replacement);
      if (enabled) {
        await vi.waitFor(() => expect(batches.flat().filter((event) => event.name === "whiteboard.watchdog.replace")).toHaveLength(1));
        const event = batches.flat().find((event) => event.name === "whiteboard.watchdog.replace");
        expect(event).toMatchObject({ name: "whiteboard.watchdog.replace", phase: "succeeded", state: "succeeded", expectation: { checkpoint: "replacement" } });
        expect(event?.attributes).toEqual({ reason: "slow_heartbeat", backoff_ms: 1_000, round_trip_1_ms: 2_200, round_trip_2_ms: 2_100 });
      } else {
        expect(batches).toEqual([]);
      }
    } finally {
      await client.leave();
      client.dispose();
    }
  });
});
