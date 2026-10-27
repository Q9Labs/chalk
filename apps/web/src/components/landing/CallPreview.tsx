import { useEffect, useRef, useState } from "react";

import { Avatar, Faces, identityColor } from "../site/Avatar";
import { Icon } from "../site/Icon";

type CallPerson = { readonly name: string; readonly camera: boolean; readonly speaking?: boolean; readonly muted?: boolean; readonly you?: boolean };
const TEAM_CALL: readonly CallPerson[] = [
  { name: "Nora Patel", camera: true, speaking: true },
  { name: "Akash Rao", camera: false, muted: true },
  { name: "Sofia Lind", camera: true },
  { name: "Hasan Shoaib", camera: true, you: true },
];

function mix(hex: string, amount: number, target: number): string {
  const channels = [1, 3, 5].map((at) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16);
    return Math.round(value + (target - value) * amount)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/** A stand-in camera picture: a window behind a person, in the person's identity color. */
function CameraPicture({ name }: { readonly name: string }) {
  const color = identityColor(name);
  const shade = mix(color, 0.5, 0);
  const figure = mix(color, 0.12, 255);
  return (
    <svg className="cam" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="160" height="90" fill={shade} />
      <rect x="12" y="8" width="30" height="40" rx="2" fill={mix(color, 0.45, 255)} opacity=".28" />
      <path d="M27 8v40M12 28h30" stroke={shade} strokeWidth="1.5" />
      <circle cx="80" cy="40" r="15" fill={figure} />
      <path d="M50 92c1-18 13-30 30-30s29 12 30 30z" fill={figure} />
    </svg>
  );
}

export function CallPreview({ label, name = "Q9 team", people = TEAM_CALL, still = false }: { readonly label: string; readonly name?: string; readonly people?: readonly CallPerson[]; readonly still?: boolean }) {
  const [mic, setMic] = useState(true);
  const [camera, setCamera] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [hand, setHand] = useState(false);
  const [chat, setChat] = useState(false);
  const [light, setLight] = useState(false);
  const [left, setLeft] = useState(false);
  const [seconds, setSeconds] = useState(521);
  const [speaker, setSpeaker] = useState(0);
  const [toast, setToast] = useState("");
  const [messages, setMessages] = useState(() =>
    name === "Q9 team"
      ? [
          { who: "Sofia", text: "Can we move the launch to Friday?" },
          { who: "Nora", text: "Friday works for me." },
        ]
      : [
          { who: "Lena", text: "Open page 42, please." },
          { who: "Omar", text: "Got it." },
        ],
  );
  const [draft, setDraft] = useState("");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const rejoin = useRef<HTMLButtonElement>(null);
  const leave = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (still || left) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let tick = 0;
    const interval = window.setInterval(() => {
      setSeconds((value) => value + 1);
      tick++;
      if (reduced.matches) return;
      if (tick % 3 === 0)
        setSpeaker((value) => {
          for (let offset = 1; offset <= people.length; offset++) {
            const next = (value + offset) % people.length;
            const person = people[next];
            if (person && !person.you && !person.muted) return next;
          }
          return value;
        });
      if (tick % 11 === 4) setToast(name === "Q9 team" ? (tick % 22 < 11 ? "Malik Haddad" : "Nora Patel") : tick % 22 < 11 ? "June Park" : "Omar Farouk");
      if (tick % 11 === 7) setToast("");
    }, 1000);
    return () => window.clearInterval(interval);
  }, [left, name, people, still]);

  useEffect(() => {
    if (chat) messagesEnd.current?.scrollIntoView({ block: "nearest" });
  }, [messages, chat]);
  useEffect(() => {
    if (left) rejoin.current?.focus();
  }, [left]);

  return (
    <div className={`xwrap${still ? " still" : ""}`} role="group" aria-label={label}>
      <div className={`xcall${chat ? " chat" : ""}${sharing ? " sharing" : ""}`} data-theme={light ? "light" : "dark"}>
        {!still && !left ? (
          <div className="xhd">
            <div className="xname">
              <b>{name}</b>
              <span className="xt">
                {Math.floor(seconds / 60)
                  .toString()
                  .padStart(2, "0")}
                :{(seconds % 60).toString().padStart(2, "0")}
              </span>
              {sharing ? (
                <span className="xshare">
                  <Icon name="share" />
                  You are sharing
                </span>
              ) : null}
            </div>
            <span className="xpill" aria-label={`${people.length} people in this preview`}>
              <Faces names={people.slice(0, 3).map((p) => p.name)} size={24} />
              <b>{people.length}</b>
            </span>
          </div>
        ) : null}
        {!left ? (
          <div className="xstage">
            {people.map((person, index) => (
              <div key={person.name} className={`xtile${(still ? person.speaking : index === speaker) ? " spk" : ""}`} data-cam={person.you ? camera : person.camera} data-mic={person.you ? mic : !person.muted} data-hand={person.you && hand}>
                {(person.you ? camera : person.camera) ? (
                  <CameraPicture name={person.name} />
                ) : (
                  <div className="xtr">
                    <Avatar name={person.name} size={132} tile />
                  </div>
                )}
                {person.you && hand ? (
                  <span className="xhand">
                    <Icon name="hand" />
                    Raised
                  </span>
                ) : null}
                <div className="xtag">
                  <span>{person.you ? `${person.name.split(" ")[0]} (You)` : person.name}</span>
                  {(person.you ? !mic : person.muted) ? <Icon name="micOff" /> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {!still && !left ? (
          <>
            {chat ? (
              <div className="xchat">
                <div className="xch">
                  Chat
                  <button type="button" className="xrb sm" aria-label="Close preview chat" onClick={() => setChat(false)}>
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
                  <div ref={messagesEnd} />
                </div>
                <form
                  className="xform"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!draft.trim()) return;
                    setMessages((value) => [...value, { who: "You", text: draft.trim() }]);
                    setDraft("");
                  }}
                >
                  <input aria-label="Message the preview call" placeholder="Message everyone" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={1000} />
                  <button type="submit" className="xrb" aria-label="Send preview message" disabled={!draft.trim()}>
                    <Icon name="arrowR" />
                  </button>
                </form>
              </div>
            ) : null}
            <div className="xdock">
              <span className="xsplit">
                <button type="button" className="xrb" data-on={mic} aria-pressed={mic} aria-label={mic ? "Mute microphone" : "Unmute microphone"} onClick={() => setMic((value) => !value)}>
                  <Icon name={mic ? "mic" : "micOff"} />
                </button>
                <span className="xcaret" aria-hidden="true">
                  <Icon name="down" />
                </span>
              </span>
              <span className="xsplit">
                <button type="button" className="xrb" data-on={camera} aria-pressed={camera} aria-label={camera ? "Turn camera off" : "Turn camera on"} onClick={() => setCamera((value) => !value)}>
                  <Icon name="cam" />
                  {!camera ? <span className="camera-slash" /> : null}
                </button>
                <span className="xcaret" aria-hidden="true">
                  <Icon name="down" />
                </span>
              </span>
              <button type="button" className={`xrb${sharing ? " active" : ""}`} aria-label="Share screen" aria-pressed={sharing} onClick={() => setSharing((value) => !value)}>
                <Icon name="share" />
              </button>
              <button type="button" className={`xrb${hand ? " active" : ""}`} aria-label="Raise hand" aria-pressed={hand} onClick={() => setHand((value) => !value)}>
                <Icon name="hand" />
              </button>
              <button type="button" className={`xrb${chat ? " active" : ""}`} aria-label="Open preview chat" aria-expanded={chat} onClick={() => setChat((value) => !value)}>
                <Icon name="chat" />
              </button>
              <button type="button" className={`xrb${light ? " active" : ""}`} aria-label="Toggle preview light theme" aria-pressed={light} onClick={() => setLight((value) => !value)}>
                <Icon name="sun" />
              </button>
              <button
                ref={leave}
                type="button"
                className="xrb leave"
                aria-label="Leave preview call"
                onClick={() => {
                  setLeft(true);
                  setToast("");
                }}
              >
                <Icon name="hang" />
              </button>
            </div>
            {toast ? (
              <div className="xtoast show" role="status">
                <Avatar name={toast} size={28} />
                {toast} joined
              </div>
            ) : null}
          </>
        ) : null}
        {left ? (
          <div className="xleft">
            <div>
              <b>You left the call</b>
              <p>Everyone else is still talking.</p>
              <button
                ref={rejoin}
                type="button"
                className="btn pri"
                onClick={() => {
                  setLeft(false);
                  requestAnimationFrame(() => leave.current?.focus());
                }}
              >
                Rejoin
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
