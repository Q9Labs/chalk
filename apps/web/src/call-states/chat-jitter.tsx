import { useEffect, useState } from "react";
import { Chalk } from "@q9labsai/chalk-react";
import type { ChatMessage } from "@q9labsai/chalk-client";
import { PEOPLE, SELF_NAME, SPACE_NAME, createCallStateClient, liveSnapshot } from "./fixtures";

// Sanitized message shapes from the 21 October phone recording, including overflow,
// grouped emoji, reactions, a text attachment, and receipts. No synthetic timer.
export function ChatJitterState() {
  const [client] = useState(() => {
    const messages: ChatMessage[] = ["Earlier message", "hello 123", "yoo", "🔥", "all cool?", "yp", "", "awesome", "UI is top notch?", "inspired by SpaceX", ":)"].map((text, index) => ({
      messageId: `jitter-${index}`,
      clientMessageId: `jitter-${index}`,
      sequence: String(index + 1),
      participantId: index === 1 || index === 5 ? "you" : "nora",
      displayName: index === 1 || index === 5 ? SELF_NAME : "Nora Patel",
      text,
      createdAt: new Date(Date.now() - (12 - index) * 60_000).toISOString(),
      attachments: index === 6 ? [{ attachmentId: "jitter-file", fileName: "Call notes.txt", mimeType: "text/plain", byteLength: 6000 }] : [],
      reactions: [3, 5, 6, 8].includes(index) ? [{ emoji: "🎉", count: 1, participantIds: ["you"] }] : [],
    }));
    const snapshot = liveSnapshot({ others: PEOPLE.slice(0, 2), chat: messages });
    return createCallStateClient({ ...snapshot, chat: { ...snapshot.chat, readReceipts: [{ participantId: "nora", participantGeneration: 1, readThroughSequence: "11", readAt: new Date().toISOString() }] } });
  });
  useEffect(() => () => client.dispose(), [client]);
  return (
    <main className="h-dvh">
      <Chalk client={client} displayName={SELF_NAME} spaceName={SPACE_NAME} theme={{ colorScheme: "dark" }} />
    </main>
  );
}
