// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { SpaceView } from "./SpaceView";

it("blocks push-to-talk during recovery but still releases a live press after recovery starts", async () => {
  const snapshot = createSnapshot(["publishAudio"]);
  const onCommand = vi.fn();
  const client = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "reconnecting" } }, { onCommand });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const key = (type: "keydown" | "keyup") => document.body.dispatchEvent(new KeyboardEvent(type, { key: " ", code: "Space", bubbles: true, cancelable: true }));
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    await act(async () => {
      key("keydown");
      key("keyup");
    });
    expect(onCommand).not.toHaveBeenCalledWith({ type: "setMicrophoneEnabled", enabled: true }, expect.anything());
    await act(async () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live" } })));
    await act(async () => {
      key("keydown");
    });
    expect(onCommand).toHaveBeenLastCalledWith({ type: "setMicrophoneEnabled", enabled: true }, expect.anything());
    await act(async () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "reconnecting" } })));
    await act(async () => {
      key("keyup");
    });
    expect(onCommand).toHaveBeenLastCalledWith({ type: "setMicrophoneEnabled", enabled: false }, expect.anything());
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it.each(["observer", "custom-reader"])("keeps chat history available without write actions for %s", async (role) => {
  const base = createSnapshot([]);
  const client = createPreviewClient({
    ...base,
    self: { ...base.self, participantId: "self", role },
    chat: {
      ...base.chat,
      status: "ready",
      messages: [
        {
          messageId: "message-1",
          clientMessageId: "client-message-1",
          sequence: "1",
          participantId: "peer",
          displayName: "Peer",
          text: "Welcome to the call",
          createdAt: "2026-10-18T00:00:00Z",
          attachments: [],
          reactions: [{ emoji: "👏", count: 1, participantIds: ["peer"] }],
          reactionRevision: "1",
        },
      ],
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView spaceName="Test call" initialPanel="chat" features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    expect(container.textContent).toContain("Welcome to the call");
    expect(container.querySelector('[aria-label="Message"]')).toHaveProperty("disabled", true);
    expect(container.querySelector('[aria-label="Send message"]')).toHaveProperty("disabled", true);
    expect(container.querySelector('[aria-label="Attach files"]')).toBeNull();
    expect(container.querySelector('[aria-label="React to this message"]')).toBeNull();
    expect(container.querySelector('[aria-label="👏, 1: peer"]')).toHaveProperty("disabled", true);
    const chatButton = container.querySelector('[aria-label="Chat"]');
    expect(chatButton).not.toBeNull();

    const writer = createSnapshot(["sendChat"]);
    await act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, self: { ...snapshot.self, capabilities: writer.self.capabilities, can: writer.self.can } })));
    expect(container.querySelector('[aria-label="Message"]')).toHaveProperty("disabled", false);
    expect(container.querySelector('[aria-label="Attach files"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="React to this message"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});
