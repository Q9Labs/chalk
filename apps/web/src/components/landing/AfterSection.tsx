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
  return (
    <section className="band" aria-labelledby="after-title">
      <div className="ctn">
        <h2 className="h2" id="after-title">
          After the call, it’s all there.
        </h2>
        <p className="sub">Open any past session to watch the recording, search the transcript and see who came and when.</p>
        <div className="cols3">
          <div>
            <h3>Recording</h3>
            <p>Turn it on in the call, and it’s saved to the session.</p>
            <div className="mplay">
              <CallPreview label="A paused recording of a call with four people, at 15:42 of 46:10" layout="still" initialWidth={380} />
              <span className="mp-btn" aria-hidden="true">
                <Icon name="play" />
              </span>
              <span className="mp-bar" aria-hidden="true">
                <i />
              </span>
              <span className="mp-t mono" aria-hidden="true">
                15:42 / 46:10
              </span>
            </div>
          </div>
          <div>
            <h3>Transcript</h3>
            <p>Search it, and jump to the moment someone said it.</p>
            <div className="mtr">
              <span className="mtr-q">
                <Icon name="search" />
                Friday<em>2 matches</em>
              </span>
              {TRANSCRIPT.map((line) => (
                <div key={line.at} className="mtr-l">
                  <span className="mono">{line.at}</span>
                  <div>
                    <b>{line.name}</b>
                    <p>
                      {line.before}
                      <mark>Friday</mark>
                      {line.after}
                    </p>
                  </div>
                </div>
              ))}
              <div className="mtr-l">
                <span className="mono">02:04</span>
                <div>
                  <b>Akash Rao</b>
                  <p>Yes. The recording fix lands Monday.</p>
                </div>
              </div>
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
