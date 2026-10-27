import { useEffect, useState } from "react";

import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { CallPreview } from "./CallPreview";

const TRANSCRIPT = [
  { at: "01:32", name: "Sofia Lind", before: "I’d move the launch to ", after: ", so review has two clear days." },
  { at: "01:50", name: "Hasan Shoaib", before: "", after: " works. Akash, does that fit the API side?" },
] as const;

const WHO_CAME = [
  { name: "Hasan Shoaib", from: "10:02", to: "10:48", untilEnd: true },
  { name: "Nora Patel", from: "10:04", to: "10:48", untilEnd: true },
  { name: "Akash Rao", from: "10:03", to: "10:48", untilEnd: true },
  { name: "Sofia Lind", from: "10:05", to: "10:41", untilEnd: false },
  { name: "Malik Haddad", from: "10:09", to: "10:48", untilEnd: true },
] as const;

export function AfterSection() {
  const [position, setPosition] = useState(942);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const interval = window.setInterval(
      () =>
        setPosition((value) => {
          if (value >= 2769) {
            setPlaying(false);
            return 2770;
          }
          return value + 1;
        }),
      1000,
    );
    return () => window.clearInterval(interval);
  }, [playing]);
  function seek(at: string) {
    const [minutes = "0", seconds = "0"] = at.split(":");
    setPosition(Number(minutes) * 60 + Number(seconds));
    setPlaying(true);
  }
  const timestamp = `${Math.floor(position / 60)
    .toString()
    .padStart(2, "0")}:${(position % 60).toString().padStart(2, "0")}`;
  return (
    <section className="band" aria-labelledby="after-title">
      <div className="ctn">
        <h2 className="h2" id="after-title">
          After the call, it’s all there.
        </h2>
        <p className="sub">Open any past session to watch the recording, search the transcript and see who came and when.</p>
        <div className="aftercard">
          <div>
            <h3 id="recording">Recording</h3>
            <p>Turn it on in the call, and it’s saved to the session.</p>
            <button type="button" className="mplay" aria-label={`${playing ? "Pause" : "Play"} example recording at ${timestamp}`} onClick={() => setPlaying((value) => !value)}>
              <CallPreview label="Example recording frame" still />
              <span className="mp-btn" aria-hidden="true">
                {playing ? "Ⅱ" : <Icon name="play" />}
              </span>
              <span className="mp-bar" aria-hidden="true">
                <i style={{ width: `${(position / 2770) * 100}%` }} />
              </span>
              <span className="mp-t mono">{timestamp} / 46:10</span>
            </button>
          </div>
          <div>
            <h3 id="transcript">Transcript</h3>
            <p>Search it, and jump to the moment someone said it.</p>
            <div className="mtr">
              <span className="mtr-q">
                <Icon name="search" />
                Friday<em>2 matches</em>
              </span>
              {TRANSCRIPT.map((line) => (
                <button type="button" key={line.at} className="mtr-l" onClick={() => seek(line.at)} aria-label={`Seek recording to ${line.at}: ${line.name}`}>
                  <span className="mono">{line.at}</span>
                  <div>
                    <b>{line.name}</b>
                    <p>
                      {line.before}
                      <mark>Friday</mark>
                      {line.after}
                    </p>
                  </div>
                </button>
              ))}
              <button type="button" className="mtr-l" onClick={() => seek("02:04")} aria-label="Seek recording to 02:04: Akash Rao">
                <span className="mono">02:04</span>
                <div>
                  <b>Akash Rao</b>
                  <p>Yes. The recording fix lands Monday.</p>
                </div>
              </button>
            </div>
          </div>
          <div>
            <h3>Who came</h3>
            <p>Everyone who joined, once each, from when they first came to when they last left.</p>
            <ul className="mwho">
              {WHO_CAME.map((person) => (
                <li key={person.name}>
                  <Avatar name={person.name} size={24} />
                  <span>{person.name}</span>
                  <span className="wr mu">
                    <span className="mono">
                      {person.from} to {person.to}
                    </span>
                    {person.untilEnd ? <span className="till">until the end</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="fine">The transcript is made from the recording, so a session without a recording has neither.</p>
      </div>
    </section>
  );
}
