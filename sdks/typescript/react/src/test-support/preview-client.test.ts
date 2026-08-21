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

  it("projects visible commands into the local snapshot", async () => {
    const client = createPreviewClient();
    await client.media.setMicrophoneEnabled(true);
    expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");

    const request = await client.participants.requestMedia("nora", "camera");
    expect(request.status).toBe("delivered");
    expect(client.getSnapshot().media.incomingRequests).toHaveLength(1);
    await client.media.declineRequest(request.requestId);
    expect(client.getSnapshot().media.incomingRequests).toHaveLength(0);

    await client.chat.send({ text: "hello" });
    expect(client.getSnapshot().chat.pendingSends[0]?.text).toBe("hello");
  });

  it("accepts an incoming request and updates the requested local source", async () => {
    const client = createPreviewClient();
    const request = await client.participants.requestMedia("nora", "microphone");

    await client.media.acceptRequest(request.requestId);

    expect(client.getSnapshot().media.incomingRequests).toHaveLength(0);
    expect(client.getSnapshot().media.local.microphone.state).toBe("enabled");
  });

  it("allows integration owners to replace command projection and observe commands", async () => {
    const commands: string[] = [];
    const client = createPreviewClient(createSnapshot(), {
      updateCommand: (snapshot, command) => (command.type === "renameSelf" ? { ...snapshot, self: { ...snapshot.self, displayName: command.displayName } } : snapshot),
      onCommand: (command) => commands.push(command.type),
    });

    await client.participants.renameSelf("Local reviewer");

    expect(client.getSnapshot().self.displayName).toBe("Local reviewer");
    expect(commands).toEqual(["renameSelf"]);
  });
});

describe("createSnapshot", () => {
  it("wires capabilities into the self.can gate", () => {
    const snapshot = createSnapshot(["sendChat"]);
    expect(snapshot.self.can("sendChat")).toBe(true);
    expect(snapshot.self.can("manageAdmission")).toBe(false);
  });

  it("provides deterministic media devices and selections for settings", () => {
    const snapshot = createSnapshot();
    expect(snapshot.media.devices.cameras).toEqual([
      { deviceId: "preview-camera", label: "Preview camera" },
      { deviceId: "preview-camera-wide", label: "Preview camera · wide" },
    ]);
    expect(snapshot.media.selection).toEqual({ microphone: "preview-microphone", camera: "preview-camera", speaker: "preview-speaker" });
  });
});
