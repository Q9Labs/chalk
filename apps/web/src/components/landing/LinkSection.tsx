import { Faces } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { Facts, type Fact } from "./Facts";

const PAST_SESSIONS = [
  { day: "Thu 15 Oct", start: "16:30", length: "42 min", people: ["Hasan Shoaib", "Nora Patel", "Priya Shah", "Ali Raza"], recorded: true },
  { day: "Tue 13 Oct", start: "10:00", length: "21 min", people: ["Hasan Shoaib", "Akash Rao", "Sofia Lind"], recorded: false },
  { day: "Mon 12 Oct", start: "10:01", length: "54 min", people: ["Hasan Shoaib", "Nora Patel", "Akash Rao", "Sofia Lind", "Priya Shah", "Eli Cohen"], recorded: true },
] as const;

const FACTS: readonly Fact[] = [
  { icon: "link", title: "The same link every time", line: "No new invite for the weekly call, and no date in the link." },
  { icon: "users", title: "The first person in starts it", line: "Nobody schedules it, and only one session runs at a time." },
  { icon: "clock", title: "Every session stays findable", line: "The call keeps its history: when, how long, and who came." },
];

/** A call's page, drawn as it looks in the dashboard. */
function CallPanel() {
  return (
    <div className="surf lpanel" role="img" aria-label="A call’s page in Chalk: Q9 team is live with three people, above its past sessions">
      <div className="lp-h" aria-hidden="true">
        <div>
          <b>Q9 team</b>
          <span className="mono">chalkmeet.com/abc-defg-hij</span>
        </div>
        <span className="btn pri sm">Join call</span>
      </div>
      <div className="lp-live" aria-hidden="true">
        <span className="status">
          <span className="dot" />
          Live now
        </span>
        <Faces names={["Nora Patel", "Akash Rao", "Sofia Lind"]} size={24} />
        <span className="mu">Nora, Akash and Sofia are in the call</span>
      </div>
      <div className="lp-sub" aria-hidden="true">
        Past sessions
      </div>
      {PAST_SESSIONS.map((session) => (
        <div key={session.day} className="lp-row" aria-hidden="true">
          <span>{session.day}</span>
          <span className="num mu">{session.start}</span>
          <span className="num mu">{session.length}</span>
          <Faces names={session.people} size={22} />
          <span className="lp-k">
            {session.recorded ? (
              <>
                <Icon name="film" />
                Recording
              </>
            ) : (
              "No recording"
            )}
          </span>
        </div>
      ))}
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
