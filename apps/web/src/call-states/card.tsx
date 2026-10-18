import { useEffect, useState } from "react";
import { Chalk } from "@q9labsai/chalk-react";
import type { ChatAttachment, ChatUploadFile } from "@q9labsai/chalk-client";
import type { CallState } from "./states";
import { HOST, PEOPLE, SELF_NAME, SPACE_NAME, chatMessages, createCallStateClient, liveSnapshot } from "./fixtures";

const photo = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#315f72"/><circle cx="240" cy="210" r="120" fill="#80b879"/><path d="M0 480L240 240L480 480" fill="#d9b641"/></svg>')}`;

export function CardState({ host = false, scheme = "dark", participants = true }: { readonly host?: boolean; readonly scheme?: "dark" | "light"; readonly participants?: boolean }) {
  const [client] = useState(() => {
    const snapshot = liveSnapshot({ others: [PEOPLE[0]!, { ...PEOPLE[1]!, handRaised: true }, { id: "rtl", name: "عبد الرحمن محمد الطويل بن أحمد", microphone: false, camera: false, handRaised: true }], ...(host ? { capabilities: HOST, admission: true } : {}), chat: chatMessages() });
    const preview = createCallStateClient(snapshot);
    const urls = new Map<string, string>([["a1", photo]]);
    let attachment = 0;
    const upload = async (file: ChatUploadFile) => {
      const fileName = "name" in file ? file.name : file.fileName;
      const mimeType = "type" in file ? file.type : file.mimeType;
      const result: ChatAttachment = { attachmentId: `card-upload-${++attachment}`, fileName, byteLength: "size" in file ? file.size : file.bytes.byteLength, mimeType: mimeType === "image/png" ? "image/png" : "text/plain" };
      urls.set(result.attachmentId, photo);
      return result;
    };
    return { ...preview, chat: { ...preview.chat, files: { ...preview.chat.files, upload, resolveUrl: async (file: ChatAttachment) => urls.get(file.attachmentId) ?? photo } } };
  });
  useEffect(() => () => client.dispose(), [client]);
  return (
    <main className="h-dvh">
      <Chalk client={client} displayName={SELF_NAME} spaceName={SPACE_NAME} theme={{ colorScheme: scheme }} features={{ participants }} />
    </main>
  );
}

export const CARD_STATES: readonly CallState[] = [
  { id: "card-chat-only", title: "Card: Chat without People", render: () => <CardState participants={false} /> },
  { id: "card-people", title: "Card: People", actions: [{ click: "Participants" }], render: () => <CardState host /> },
  { id: "card-chat", title: "Card: Chat", actions: [{ click: "Chat" }], render: () => <CardState host /> },
  { id: "card-guest", title: "Card: guest", actions: [{ click: "Participants" }], render: () => <CardState /> },
  { id: "card-people-light", title: "Card: People Light", actions: [{ click: "Participants" }], render: () => <CardState host scheme="light" /> },
  { id: "card-chat-light", title: "Card: Chat Light", actions: [{ click: "Chat" }], render: () => <CardState host scheme="light" /> },
];
