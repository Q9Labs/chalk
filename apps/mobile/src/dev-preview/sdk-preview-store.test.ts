import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";
import { createPreviewSnapshot, createPreviewStore } from "./sdk-preview-store";

describe("native SDK preview store", () => {
  it("projects exact client snapshot participants and local media", () => {
    const snapshot = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "happy", mic: false, camera: false, hand: true });

    expect(snapshot.participants).toHaveLength(2);
    expect(snapshot.participants[0]).toMatchObject({ participantSessionId: "you", handRaised: true, role: "host" });
    expect(snapshot.localMedia).toMatchObject({ microphone: { state: "disabled", track: null }, camera: { state: "disabled", track: null }, screen: { state: "disabled", track: null } });
    expect(snapshot.participantMedia.you).toMatchObject({ microphone: "inactive", camera: "inactive" });
  });

  it("keeps empty and failure states in the snapshot contract", () => {
    const empty = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "empty", participants: 0, chat: "empty" });
    const failed = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "failure" });

    expect(empty.participants).toHaveLength(0);
    expect(empty.chat.messages).toHaveLength(0);
    expect(failed.state).toBe("failed");
    expect(failed.failure?.code).toBe("sync_start_failed");
  });

  it("projects nonterminal recovery phases for the production connection banner", () => {
    const reconnecting = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "reconnecting" });
    const retry = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "retry" });
    const warning = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "warning" });
    const timeout = createPreviewSnapshot({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "timeout" });

    expect(reconnecting).toMatchObject({ state: "reconnecting", connection: { sync: "recovering", media: "recovering" }, failure: null });
    expect(retry).toMatchObject({ state: "live", connection: { sync: "failed", media: "healthy" }, failure: { recoverable: true } });
    expect(warning).toMatchObject({ state: "live", connection: { sync: "healthy", media: "failed" }, failure: { code: "media_recovery_exhausted", recoverable: true } });
    expect(timeout.state).toBe("failed");
  });

  it("mutates the Set-subscribed store without creating a transport", async () => {
    const store = createPreviewStore({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "happy" });
    let updates = 0;
    store.subscribe(() => {
      updates += 1;
    });

    await store.setMicrophoneEnabled(false);
    await store.setCameraEnabled(false);
    await store.setHandRaised(true);
    await store.sendReaction("👍");
    await store.sendChatMessage({ text: "Fixture message" });
    await store.admitParticipant("admission-1");

    expect(updates).toBe(6);
    expect(store.getSnapshot().localMedia.microphone.state).toBe("disabled");
    expect(store.getSnapshot().localMedia.camera.state).toBe("disabled");
    expect(store.getSnapshot().participants[0]?.handRaised).toBe(true);
    expect(store.getSnapshot().reactions.at(-1)?.reaction).toBe("👍");
    expect(store.getSnapshot().chat.messages.at(-1)?.text).toBe("Fixture message");
    expect(store.getSnapshot().admissionRequests).toHaveLength(1);
    expect(store.chatFiles).toBeNull();
    expect(store.whiteboard).not.toBeNull();
  });
});
