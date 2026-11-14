import { Avatar, Faces, identityColor } from "../site/Avatar";
import { Icon } from "../site/Icon";

export type CallPerson = { readonly name: string; readonly camera: boolean; readonly speaking?: boolean; readonly muted?: boolean; readonly you?: boolean };

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

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;

export function PreviewHeader({ name, seconds, sharing, people }: { readonly name: string; readonly seconds: number; readonly sharing: boolean; readonly people: readonly CallPerson[] }) {
  return (
    <div className="xhd">
      <div className="xname">
        <b>{name}</b>
        <span className="xt">{clock(seconds)}</span>
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
  );
}

type Controls = { readonly mic: boolean; readonly camera: boolean; readonly hand: boolean };

function Tile({ person, speaking, controls }: { readonly person: CallPerson; readonly speaking: boolean; readonly controls: Controls }) {
  const you = person.you === true;
  const cameraOn = you ? controls.camera : person.camera;
  const muted = you ? !controls.mic : person.muted === true;
  return (
    <div className={`xtile${speaking ? " spk" : ""}`} data-cam={cameraOn} data-mic={!muted} data-hand={you && controls.hand}>
      {cameraOn ? (
        <CameraPicture name={person.name} />
      ) : (
        <div className="xtr">
          <Avatar name={person.name} size={132} tile />
        </div>
      )}
      {you && controls.hand ? (
        <span className="xhand">
          <Icon name="hand" />
          Raised
        </span>
      ) : null}
      <div className="xtag">
        <span>{you ? `${person.name.split(" ")[0]} (You)` : person.name}</span>
        {muted ? <Icon name="micOff" /> : null}
      </div>
    </div>
  );
}

export function PreviewStage({ people, still, speaker, controls }: { readonly people: readonly CallPerson[]; readonly still: boolean; readonly speaker: number; readonly controls: Controls }) {
  return (
    <div className="xstage">
      {people.map((person, index) => (
        <Tile key={person.name} person={person} speaking={still ? person.speaking === true : index === speaker} controls={controls} />
      ))}
    </div>
  );
}
