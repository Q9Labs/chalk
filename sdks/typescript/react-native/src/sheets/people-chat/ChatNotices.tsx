import { useEffect, useRef } from "react";
import { FaceAvatar } from "../../avatar/FaceAvatar";
import { usePreferences } from "../../frame/preferences";
import { useChat, useSelf } from "../../hooks/space-hooks";
import { announce } from "../../primitives/announce";
import { useToasts } from "../../primitives/toast/ToastStack";
import { playSound } from "../../sounds/sounds";
import { messageSummary } from "./chat-model";

export type ChatNoticesProps = {
  /** True while the Chat tab is in view; new messages then only sound and are announced. */
  readonly chatVisible: boolean;
  /** True while the People and Chat sheet is open on either tab; the Chat tab's dot shows instead of a toast. */
  readonly sheetOpen: boolean;
  readonly onOpenChat: () => void;
};

/**
 * New messages from others (F4): the message sound and an announcement, and while the sheet is
 * closed a notice with the sender's first name, the message and Reply. Messages already in the
 * history when the call opens stay quiet.
 */
export function ChatNotices({ chatVisible, sheetOpen, onOpenChat }: ChatNoticesProps): null {
  const { messages, status } = useChat();
  const self = useSelf();
  const toasts = useToasts();
  const { soundsEnabled } = usePreferences();
  const seen = useRef<ReadonlySet<string> | null>(null);
  const latest = useRef({ chatVisible, sheetOpen, onOpenChat, soundsEnabled });
  latest.current = { chatVisible, sheetOpen, onOpenChat, soundsEnabled };

  useEffect(() => {
    if (status !== "ready") return;
    const previous = seen.current;
    seen.current = new Set(messages.map((message) => message.messageId));
    if (!previous) return;
    const fresh = messages.filter((message) => !previous.has(message.messageId) && message.participantId !== self.participantId);
    const now = latest.current;
    for (const message of fresh) {
      const text = messageSummary(message.text, message.attachments);
      playSound("message", now.soundsEnabled);
      if (now.chatVisible || now.sheetOpen) {
        announce(`New message from ${message.displayName}: ${text}`);
        continue;
      }
      // The notice announces itself.
      const id = toasts.show({
        leading: <FaceAvatar name={message.displayName} size={28} />,
        message: [{ strong: firstName(message.displayName) }, ` ${text}`],
        actions: [
          {
            label: "Reply",
            onPress: () => {
              toasts.dismiss(id);
              latest.current.onOpenChat();
            },
            testID: "toast.chat.reply",
          },
        ],
        testID: "toast.chat",
      });
    }
  }, [messages, self.participantId, status, toasts]);
  return null;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
