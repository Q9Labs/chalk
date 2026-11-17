import { describe, expect, it } from "vitest";
import { createTestOutbox } from "../telemetry/outbox.test.helpers";
import { V1SyncError } from "./v1-error";
import { reportLiveTarget } from "./v1-live-target-telemetry";

const requestId = "7d3c9a52-6f0e-4d8a-9b1e-2c5f4a6e8b10";

async function eventsOf(run: (outbox: ReturnType<typeof createTestOutbox>["outbox"]) => Promise<unknown>) {
  const test = createTestOutbox();
  await run(test.outbox).catch(() => undefined);
  await test.outbox.flush();
  return test.accepted;
}

describe("reportLiveTarget", () => {
  it("records the intent and the result of a mute under the id the Sync frame carries", async () => {
    const events = await eventsOf((outbox) => reportLiveTarget(outbox, "set_microphone_enabled", false, requestId, async () => "done"));
    expect(events).toMatchObject([
      { type: "media_intent", action: "mute", source: "microphone", op_id: requestId },
      { type: "media_result", action: "mute", source: "microphone", op_id: requestId, outcome: "succeeded", duration_ms: expect.any(Number) },
    ]);
  });

  it("gives a request id that is not a UUID a fresh telemetry id, so the server accepts both events", async () => {
    const events = await eventsOf((outbox) => reportLiveTarget(outbox, "set_microphone_enabled", true, "custom-request-id", async () => "done"));
    expect(events).toHaveLength(2);
    expect(events[0]?.op_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(events[1]?.op_id).toBe(events[0]?.op_id);
  });

  it.each([
    ["set_microphone_enabled", true, "unmute", "microphone"],
    ["set_camera_enabled", true, "publish", "camera"],
    ["set_camera_enabled", false, "unpublish", "camera"],
    ["set_screen_share_enabled", true, "share_start", "screen_video"],
    ["set_screen_share_enabled", false, "share_stop", "screen_video"],
  ] as const)("names %s with enabled=%s as %s", async (name, enabled, action, source) => {
    const events = await eventsOf((outbox) => reportLiveTarget(outbox, name, enabled, requestId, async () => "done"));
    expect(events[0]).toMatchObject({ type: "media_intent", action, source });
  });

  it.each([
    ["media_timeout", "media_timeout"],
    ["signaling_timeout", "media_timeout"],
    ["retry_exhausted", "retry_exhausted"],
    ["not_live", "not_live"],
    ["terminal_failure", "command_rejected"],
  ])("maps the failure %s to the closed code %s and rethrows it", async (code, expected) => {
    const error = new V1SyncError("raw message that must not leave the device", code);
    const test = createTestOutbox();
    await expect(reportLiveTarget(test.outbox, "set_camera_enabled", true, requestId, () => Promise.reject(error))).rejects.toBe(error);
    await test.outbox.flush();
    expect(test.accepted.at(-1)).toMatchObject({ type: "media_result", outcome: "failed", code: expected });
    expect(JSON.stringify(test.accepted)).not.toContain("raw message");
  });

  it("just sends when no outbox is bound", async () => {
    await expect(reportLiveTarget(undefined, "set_camera_enabled", true, requestId, async () => "done")).resolves.toBe("done");
  });
});
