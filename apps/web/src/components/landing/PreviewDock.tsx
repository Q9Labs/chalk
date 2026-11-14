import type { Ref } from "react";

import { Icon, type IconName } from "../site/Icon";

export type Toggles = { readonly mic: boolean; readonly camera: boolean; readonly sharing: boolean; readonly hand: boolean; readonly chat: boolean; readonly light: boolean };
export type ToggleKey = keyof Toggles;

const PLAIN: readonly { readonly key: "sharing" | "hand" | "chat" | "light"; readonly icon: IconName; readonly label: string }[] = [
  { key: "sharing", icon: "share", label: "Share screen" },
  { key: "hand", icon: "hand", label: "Raise hand" },
  { key: "chat", icon: "chat", label: "Open preview chat" },
  { key: "light", icon: "sun", label: "Toggle preview light theme" },
];

function Split({ on, label, icon, slash = false, onClick }: { readonly on: boolean; readonly label: string; readonly icon: IconName; readonly slash?: boolean; readonly onClick: () => void }) {
  return (
    <span className="xsplit">
      <button type="button" className="xrb" data-on={on} aria-pressed={on} aria-label={label} onClick={onClick}>
        <Icon name={icon} />
        {slash ? <span className="camera-slash" /> : null}
      </button>
      <span className="xcaret" aria-hidden="true">
        <Icon name="down" />
      </span>
    </span>
  );
}

export function PreviewDock({ on, flip, leave, onLeave }: { readonly on: Toggles; readonly flip: (key: ToggleKey) => void; readonly leave: Ref<HTMLButtonElement>; readonly onLeave: () => void }) {
  return (
    <div className="xdock">
      <Split on={on.mic} label={on.mic ? "Mute microphone" : "Unmute microphone"} icon={on.mic ? "mic" : "micOff"} onClick={() => flip("mic")} />
      <Split on={on.camera} label={on.camera ? "Turn camera off" : "Turn camera on"} icon="cam" slash={!on.camera} onClick={() => flip("camera")} />
      {PLAIN.map(({ key, icon, label }) => (
        <button key={key} type="button" className={`xrb${on[key] ? " active" : ""}`} aria-label={label} {...(key === "chat" ? { "aria-expanded": on.chat } : { "aria-pressed": on[key] })} onClick={() => flip(key)}>
          <Icon name={icon} />
        </button>
      ))}
      <button ref={leave} type="button" className="xrb leave" aria-label="Leave preview call" onClick={onLeave}>
        <Icon name="hang" />
      </button>
    </div>
  );
}
