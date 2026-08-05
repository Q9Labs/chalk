import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";
import { createPreviewSnapshot, createPreviewStore } from "./sdk-preview-store";

describe("native SDK preview store", () => {
  it("projects the canonical SpaceSnapshot participants and local media", () => {
    const snapshot = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "happy", mic: false, camera: false, hand: true });

    expect(snapshot.participants.roster).toHaveLength(2);
    expect(snapshot.participants.roster[0]).toMatchObject({ participantId: "you", handRaised: true, role: "owner" });
    expect(snapshot.media.local).toMatchObject({ microphone: { state: "disabled", track: null }, camera: { state: "disabled", track: null }, screen: { state: "disabled", track: null } });
    expect(snapshot.participants.roster[0]?.media).toMatchObject({ microphone: "inactive", camera: "inactive" });
  });

  it("keeps empty and failure states in the canonical snapshot contract", () => {
    const empty = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "empty", participants: 0, chat: "empty" });
    const failed = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "failure" });

    expect(empty.participants.roster).toHaveLength(0);
    expect(empty.chat.messages).toHaveLength(0);
    expect(failed.connection.status).toBe("failed");
    expect(failed.connection.lastError?.code).toBe("connection.sync_start_failed");
  });

  it("projects nonterminal recovery phases for the canonical connection slice", () => {
    const reconnecting = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "reconnecting" });
    const retry = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "retry" });
    const warning = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "warning" });
    const timeout = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "timeout" });

    expect(reconnecting).toMatchObject({ connection: { status: "reconnecting", lastError: null } });
    expect(retry).toMatchObject({ connection: { status: "live", lastError: { recoverable: true } } });
    expect(warning).toMatchObject({ connection: { status: "live", lastError: { code: "connection.media_recovery_exhausted", recoverable: true } } });
    expect(timeout.connection.status).toBe("failed");
  });

  it("mutates the SpaceClient store without creating a transport", async () => {
    const store = createPreviewStore({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "happy" });
    let updates = 0;
    store.subscribe(() => {
      updates += 1;
    });

    await store.media.setMicrophoneEnabled(false);
    await store.media.setCameraEnabled(false);
    await store.participants.raiseHand();
    await store.reactions.send("👍");
    await store.chat.send({ text: "Fixture message" });
    await store.participants.admit("admission-1");

    expect(updates).toBe(6);
    expect(store.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(store.getSnapshot().media.local.camera.state).toBe("disabled");
    expect(store.getSnapshot().self.handRaised).toBe(true);
    expect(store.getSnapshot().reactions.active.at(-1)?.reaction).toBe("👍");
    expect(store.getSnapshot().chat.messages.at(-1)?.text).toBe("Fixture message");
    expect(store.getSnapshot().chat.messages.at(-1)?.clientMessageId).toBe("preview-client-4");
    expect(store.getSnapshot().participants.admissionQueue).toHaveLength(1);
  });
});
