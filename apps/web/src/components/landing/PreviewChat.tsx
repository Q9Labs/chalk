import { useEffect, useRef } from "react";

import { Icon } from "../site/Icon";

export type PreviewMessage = { readonly who: string; readonly text: string };

export function initialMessages(team: boolean): PreviewMessage[] {
  return team
    ? [
        { who: "Sofia", text: "Can we move the launch to Friday?" },
        { who: "Nora", text: "Friday works for me." },
      ]
    : [
        { who: "Lena", text: "Open page 42, please." },
        { who: "Omar", text: "Got it." },
      ];
}

export function PreviewChat({ messages, draft, onDraft, onSend, onClose }: { readonly messages: readonly PreviewMessage[]; readonly draft: string; readonly onDraft: (value: string) => void; readonly onSend: () => void; readonly onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  return (
    <div className="xchat">
      <div className="xch">
        Chat
        <button type="button" className="xrb sm" aria-label="Close preview chat" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="xmsgs" role="log" aria-label="Preview messages">
        {messages.map((message, index) => (
          <div className={`xm${message.who === "You" ? " me" : ""}`} key={index}>
            <b>{message.who}</b>
            <span>{message.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="xform"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <input aria-label="Message the preview call" placeholder="Message everyone" value={draft} onChange={(event) => onDraft(event.target.value)} maxLength={1000} />
        <button type="submit" className="xrb" aria-label="Send preview message" disabled={!draft.trim()}>
          <Icon name="arrowR" />
        </button>
      </form>
    </div>
  );
}
