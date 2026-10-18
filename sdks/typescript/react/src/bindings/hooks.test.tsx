/* @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ChalkProvider } from "./context";
import { useChat, useScreenShare } from "./hooks";
import { createPreviewClient } from "../test-support/preview-client";

it("exposes reaction counts, who reacted, self membership, and the set/clear action", async () => {
  const client = createPreviewClient();
  const selfId = "00000000-0000-4000-8000-000000000001";
  client.updateSnapshot((snapshot) => ({
    ...snapshot,
    self: { ...snapshot.self, participantId: selfId },
    chat: {
      ...snapshot.chat,
      messages: [{ messageId: "message-1", clientMessageId: "client-message-1", sequence: "1", participantId: "peer", displayName: "Peer", text: "Hello", createdAt: "2026-10-18T00:00:00Z", attachments: [], reactions: [{ emoji: "👏", count: 1, participantIds: ["peer"] }], reactionRevision: "1" }],
    },
  }));
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    const chat = useChat();
    const share = useScreenShare();
    const reaction = chat.messages[0]?.reactions[0];
    return (
      <button data-mine={reaction?.isMine} data-count={reaction?.count} data-who={reaction?.participantIds.join(",")} data-source={share.capture?.surface} onClick={() => void chat.react({ messageId: "message-1", emoji: "👏", on: !reaction?.isMine })}>
        React
      </button>
    );
  }
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Probe />
        </ChalkProvider>,
      ),
    );
    const button = container.querySelector("button")!;
    expect(button.dataset).toMatchObject({ mine: "false", count: "1", who: "peer" });
    await act(async () => button.click());
    expect(button.dataset).toMatchObject({ mine: "true", count: "2", who: `peer,${selfId}` });
    await act(async () => button.click());
    expect(button.dataset).toMatchObject({ mine: "false", count: "1", who: "peer" });
  } finally {
    await act(async () => root.unmount());
    client.dispose();
  }
});
