import { afterEach, describe, expect, it, vi } from "vitest";
import { V1SyncError } from "../sync/v1-error";
import { normalizeClientError } from "./errors";
import { createV1SyncClient, InMemoryV1PendingTargetStore } from "../sync";

afterEach(() => vi.unstubAllGlobals());

describe("Sync media commands before live", () => {
  it.each(["setCameraEnabled", "setMicrophoneEnabled"] as const)("makes %s recoverable without exposing the internal target message", async (command) => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", {});
    const sync = createV1SyncClient({ url: "ws://sync.test/v1/sync", token: "fixture", pendingStore: new InMemoryV1PendingTargetStore() });
    const cause = await sync[command](true).catch((error: unknown) => error);
    expect(cause).toMatchObject({ code: "not_live", message: "self-media targets require a live participant" });
    expect(normalizeClientError(cause)).toMatchObject({ code: "connection.invalid_state", recoverable: true, message: "Wait for the call to connect, then try again." });
  });
});

describe("unexpected client exceptions", () => {
  it("keeps unclassified exceptions internal and nonrecoverable", () => {
    expect(normalizeClientError(new Error("Unexpected operation failure"))).toMatchObject({ code: "client.internal_error", recoverable: false, message: "Unexpected operation failure" });
  });
});

describe("Sync reaction confirmation", () => {
  it("reports an unconfirmed reaction recoverably without claiming non-delivery", () => {
    expect(normalizeClientError(new V1SyncError("internal acknowledgement deadline", "reaction_ack_timeout"))).toMatchObject({ code: "collaboration.unavailable", recoverable: true, message: "Couldn’t confirm your reaction. Try again." });
  });
  it("does not classify unrelated exhausted retries as media failures", () => {
    expect(normalizeClientError(new V1SyncError("command retries exhausted", "retry_exhausted"))).toMatchObject({ code: "client.internal_error", recoverable: false });
  });
});
