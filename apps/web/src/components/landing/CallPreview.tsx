import { useEffect, useRef, useState, type Ref } from "react";

import { Avatar } from "../site/Avatar";
import { PreviewChat, initialMessages } from "./PreviewChat";
import { PreviewDock, type ToggleKey, type Toggles } from "./PreviewDock";
import { PreviewHeader, PreviewStage, type CallPerson } from "./PreviewStage";
import { usePreviewClock } from "./use-preview-clock";

const TEAM_CALL: readonly CallPerson[] = [
  { name: "Nora Patel", camera: true, speaking: true },
  { name: "Akash Rao", camera: false, muted: true },
  { name: "Sofia Lind", camera: true },
  { name: "Hasan Shoaib", camera: true, you: true },
];

const INITIAL: Toggles = { mic: true, camera: true, sharing: false, hand: false, chat: false, light: false };

function LeftNotice({ rejoin, onRejoin }: { readonly rejoin: Ref<HTMLButtonElement>; readonly onRejoin: () => void }) {
  return (
    <div className="xleft">
      <div>
        <b>You left the call</b>
        <p>Everyone else is still talking.</p>
        <button ref={rejoin} type="button" className="btn pri" onClick={onRejoin}>
          Rejoin
        </button>
      </div>
    </div>
  );
}

function JoinToast({ name }: { readonly name: string }) {
  if (!name) return null;
  return (
    <div className="xtoast show" role="status">
      <Avatar name={name} size={28} />
      {name} joined
    </div>
  );
}

export function CallPreview({ label, name = "Q9 team", people = TEAM_CALL, still = false }: { readonly label: string; readonly name?: string; readonly people?: readonly CallPerson[]; readonly still?: boolean }) {
  const [on, setOn] = useState(INITIAL);
  const [left, setLeft] = useState(false);
  const [messages, setMessages] = useState(() => initialMessages(name === "Q9 team"));
  const [draft, setDraft] = useState("");
  const rejoin = useRef<HTMLButtonElement>(null);
  const leave = useRef<HTMLButtonElement>(null);
  const { seconds, speaker, toast, clearToast } = usePreviewClock({ people, team: name === "Q9 team", run: !still && !left });
  const flip = (key: ToggleKey) => setOn((value) => ({ ...value, [key]: !value[key] }));
  const live = !still && !left;

  useEffect(() => {
    if (left) rejoin.current?.focus();
  }, [left]);

  const send = () => {
    if (!draft.trim()) return;
    setMessages((value) => [...value, { who: "You", text: draft.trim() }]);
    setDraft("");
  };

  return (
    <div className={`xwrap${still ? " still" : ""}`} role="group" aria-label={label}>
      <div className={`xcall${on.chat ? " chat" : ""}${on.sharing ? " sharing" : ""}`} data-theme={on.light ? "light" : "dark"}>
        {live ? <PreviewHeader name={name} seconds={seconds} sharing={on.sharing} people={people} /> : null}
        {!left ? <PreviewStage people={people} still={still} speaker={speaker} controls={on} /> : null}
        {live ? (
          <>
            {on.chat ? <PreviewChat messages={messages} draft={draft} onDraft={setDraft} onSend={send} onClose={() => flip("chat")} /> : null}
            <PreviewDock
              on={on}
              flip={flip}
              leave={leave}
              onLeave={() => {
                setLeft(true);
                clearToast();
              }}
            />
            <JoinToast name={toast} />
          </>
        ) : null}
        {left ? (
          <LeftNotice
            rejoin={rejoin}
            onRejoin={() => {
              setLeft(false);
              requestAnimationFrame(() => leave.current?.focus());
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
