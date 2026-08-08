import { describe, expect, it } from "vitest";

import { createPreviewClient, createSnapshot } from "./preview-client";

describe("createPreviewClient", () => {
  it("serves its snapshot and notifies subscribers on setSnapshot", () => {
    const initial = createSnapshot();
    const client = createPreviewClient(initial);
    expect(client.getSnapshot()).toBe(initial);

    let notifications = 0;
    const unsubscribe = client.subscribe(() => {
      notifications += 1;
    });

    const next = createSnapshot([]);
    client.setSnapshot(next);
    expect(client.getSnapshot()).toBe(next);
    expect(notifications).toBe(1);

    unsubscribe();
    client.setSnapshot(initial);
    expect(notifications).toBe(1);
  });

  it("resolves commands as no-ops so previews never throw", async () => {
    const client = createPreviewClient();
    await expect(client.media.setMicrophoneEnabled(true)).resolves.toBeUndefined();
    await expect(client.chat.send({ text: "hello" })).resolves.toBeUndefined();
  });
});

describe("createSnapshot", () => {
  it("wires capabilities into the self.can gate", () => {
    const snapshot = createSnapshot(["sendChat"]);
    expect(snapshot.self.can("sendChat")).toBe(true);
    expect(snapshot.self.can("manageAdmission")).toBe(false);
  });
});
