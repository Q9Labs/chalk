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

type Stage = { readonly width: number; readonly height: number; readonly top: number; readonly bottom: number; readonly side: number };

const DESKTOP: Stage = { width: 1440, height: 810, top: 60, bottom: 84, side: 16 };
const PHONE: Stage = { width: 390, height: 780, top: 52, bottom: 106, side: 8 };
/** A recording frame: tiles only, no header or dock. */
const STILL: Stage = { width: 1440, height: 810, top: 16, bottom: 16, side: 16 };

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

function Tiles({ stage, people }: { readonly stage: Stage; readonly people: readonly CallPerson[] }) {
  const gap = 8;
  const columns = 2;
  const rows = Math.ceil(people.length / columns);
  const tileWidth = (stage.width - stage.side * 2 - gap * (columns - 1)) / columns;
  const tileHeight = (stage.height - stage.top - stage.bottom - gap * (rows - 1)) / rows;
  const face = Math.round(Math.max(32, Math.min(150, Math.min(tileWidth, tileHeight) * 0.42)));
  return people.map((person, i) => (
    <div key={person.name} className={person.speaking ? "ctile spk" : "ctile"} style={{ left: stage.side + (i % columns) * (tileWidth + gap), top: stage.top + Math.floor(i / columns) * (tileHeight + gap), width: tileWidth, height: tileHeight }}>
      {person.camera ? (
        <CameraPicture name={person.name} />
      ) : (
        <div className="ctr">
          <Avatar name={person.name} size={face} tile />
        </div>
      )}
      <div className="ctag">
        <span>{person.you ? `${person.name.split(" ")[0]} (You)` : person.name}</span>
        {person.muted ? <Icon name="micOff" /> : null}
      </div>
    </div>
  ));
}

function SplitPill({ icon }: { readonly icon: "mic" | "cam" | "share" }) {
  return (
    <span className="csplit">
      <i>
        <Icon name={icon} />
      </i>
      <i className="car">
        <Icon name="down" />
      </i>
    </span>
  );
}

function DesktopChrome({ name, time, people }: { readonly name: string; readonly time: string; readonly people: readonly CallPerson[] }) {
  return (
    <>
      <div className="chd">
        <div className="ctl">
          {name} <span className="ctm num">{time}</span>
          <Icon name="down" />
        </div>
        <div className="chr">
          <span className="cpill">
            <Faces names={people.slice(0, 3).map((person) => person.name)} size={24} />
            <b className="num">{people.length}</b>
          </span>
          <span className="crb">
            <Icon name="grid" />
          </span>
        </div>
      </div>
      <div className="cdock">
        <SplitPill icon="mic" />
        <SplitPill icon="cam" />
        <span className="cgap" />
        <SplitPill icon="share" />
        <span className="crb">
          <Icon name="smile" />
        </span>
        <span className="crb">
          <Icon name="pen" />
        </span>
        <span className="crb">
          <Icon name="max" />
        </span>
        <span className="cgap" />
        <span className="crb leave">
          <Icon name="hang" />
        </span>
      </div>
      <span className="crb ccorner l">
        <Icon name="link" />
      </span>
      <span className="crb ccorner r">
        <Icon name="chat" />
        <i className="bd" />
      </span>
    </>
  );
}

function PhoneChrome({ name, time }: { readonly name: string; readonly time: string }) {
  return (
    <>
      <div className="chd">
        <div className="ctl">
          {name} <span className="ctm num">{time}</span>
          <Icon name="down" />
        </div>
      </div>
      <div className="cdock">
        {(["mic", "cam", "smile", "more"] as const).map((icon) => (
          <span key={icon} className="crb">
            <Icon name={icon} />
          </span>
        ))}
        <span className="crb leave">
          <Icon name="hang" />
        </span>
      </div>
    </>
  );
}

type CallPreviewProps = {
  readonly label: string;
  readonly layout?: "desktop" | "phone" | "still";
  readonly people?: readonly CallPerson[];
  readonly name?: string;
  readonly time?: string;
  /** The width the preview is drawn at before the page measures it, which keeps the prerendered page close. */
  readonly initialWidth: number;
  /** A fixed width; without it the preview fills its container. */
  readonly width?: number;
};

/**
 * A still drawing of the call in the call's real proportions. It is drawn at the call's own size and scaled to fit,
 * so the landing page shows the call without loading the call itself.
 */
export function CallPreview({ label, layout = "desktop", people = TEAM_CALL, name = "Q9 team", time = "12:08", initialWidth, width }: CallPreviewProps) {
  const stage = layout === "phone" ? PHONE : layout === "still" ? STILL : DESKTOP;
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState((width ?? initialWidth) / stage.width);

  useEffect(() => {
    const element = frame.current;
    if (width !== undefined || !element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / stage.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage.width, width]);

  return (
    <div ref={frame} className="cfit" role="img" aria-label={label} style={{ width, aspectRatio: `${stage.width} / ${stage.height}` }}>
      <div className={layout === "phone" ? "cl cph" : "cl"} style={{ width: stage.width, height: stage.height, transform: `scale(${scale})` }} aria-hidden="true">
        {layout === "desktop" ? <DesktopChrome name={name} time={time} people={people} /> : null}
        {layout === "phone" ? <PhoneChrome name={name} time={time} /> : null}
        <Tiles stage={stage} people={people} />
      </div>
    </div>
  );
}
