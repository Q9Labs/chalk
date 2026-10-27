import { useState } from "react";

import { Faces } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { Facts, type Fact } from "./Facts";

const PAST_SESSIONS = [
  { day: "Thu 15 Oct", start: "16:30", length: "42 min", people: ["Nora Patel", "Akash Rao", "Sofia Lind", "Hasan Shoaib"], recorded: true },
  { day: "Tue 13 Oct", start: "10:00", length: "21 min", people: ["Hasan Shoaib", "Nora Patel", "Akash Rao"], recorded: false },
  { day: "Mon 12 Oct", start: "10:01", length: "54 min", people: ["Sofia Lind", "Malik Haddad", "Nora Patel", "Akash Rao", "Hasan Shoaib", "Lena Vogel"], recorded: true },
  { day: "Thu 8 Oct", start: "16:30", length: "38 min", people: ["Akash Rao", "Sofia Lind", "Hasan Shoaib", "Nora Patel"], recorded: true },
  { day: "Tue 6 Oct", start: "10:00", length: "25 min", people: ["Nora Patel", "Hasan Shoaib", "Malik Haddad"], recorded: false },
  { day: "Mon 5 Oct", start: "10:02", length: "47 min", people: ["Sofia Lind", "Akash Rao", "Nora Patel", "Hasan Shoaib", "Malik Haddad"], recorded: true },
  { day: "Thu 1 Oct", start: "16:31", length: "40 min", people: ["Hasan Shoaib", "Malik Haddad", "Sofia Lind"], recorded: true },
] as const;

const FACTS: readonly Fact[] = [
  { icon: "link", title: "The same link every time", line: "No new invite for the weekly call, and no date in the link." },
  { icon: "users", title: "The first person in starts it", line: "Nobody schedules it, and only one session runs at a time." },
  { icon: "clock", title: "Every session stays findable", line: "The call keeps its history: when, how long, and who came." },
];

function CallPanel() {
  const [recorded, setRecorded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="sx" aria-label="Example call history">
      <div className="sx-h">
        <div>
          <b>Q9 team</b>
          <span className="mono mu">chalkmeet.com/abc-defg-hij</span>
        </div>
        <a className="btn pri sm" href="#hero-title">
          Join call
        </a>
      </div>
      <div className="sx-live">
        <span className="status">
          <span className="dot" />
          Live now
        </span>
        <Faces names={["Nora Patel", "Akash Rao", "Sofia Lind"]} size={26} />
        <span className="mu">Nora, Akash and Sofia are in the call</span>
      </div>
      <div className="sx-bar">
        <span className="sx-sub">Past sessions</span>
        <span className="sx-chips" role="group" aria-label="Filter sessions">
          <button type="button" className={!recorded ? "on" : ""} aria-pressed={!recorded} onClick={() => setRecorded(false)}>
            All 7
          </button>
          <button type="button" className={recorded ? "on" : ""} aria-pressed={recorded} onClick={() => setRecorded(true)}>
            Recorded 5
          </button>
        </span>
      </div>
      <div className="sx-list">
        {PAST_SESSIONS.filter((session) => !recorded || session.recorded).map((session) => (
          <div className={`sx-item${expanded === session.day ? " open" : ""}`} key={session.day}>
            <button type="button" className="sx-row" aria-expanded={expanded === session.day} onClick={() => setExpanded((value) => (value === session.day ? null : session.day))}>
              <span>{session.day}</span>
              <span className="mu num">{session.start}</span>
              <span className="mu num">{session.length}</span>
              <Faces names={session.people} size={24} />
              <span className={`sx-k${session.recorded ? " rec" : ""}`}>
                {session.recorded ? (
                  <>
                    <Icon name="play" />
                    Recording
                  </>
                ) : (
                  "No recording"
                )}
              </span>
            </button>
            {expanded === session.day ? (
              <div className="sx-more">
                <span>{session.people.length} people came</span>
                {session.recorded ? (
                  <>
                    <a href="#recording">Watch recording</a>
                    <a href="#transcript">Open transcript</a>
                  </>
                ) : (
                  <span className="mu">Nothing was recorded</span>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function LinkSection() {
  return (
    <section className="band" id="product" aria-labelledby="link-title">
      <div className="ctn split">
        <div>
          <h2 className="h2" id="link-title">
            One link, for good.
          </h2>
          <p className="sub">A call keeps its link. Send it once and it still works next week. Each time people meet is a session: it starts when the first person joins and ends when the last one leaves.</p>
          <Facts facts={FACTS} />
        </div>
        <CallPanel />
      </div>
    </section>
  );
}
