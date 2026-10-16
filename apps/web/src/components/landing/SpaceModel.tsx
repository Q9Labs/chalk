import { Illustration } from "./Illustration";
import { SpaceTimeline } from "./visuals";

const POINTS = [
  {
    id: "link",

    title: "One link, for good",
    body: "A join link names the Space, never a call. Send it once and it keeps working next week.",
  },
  {
    id: "episodes",

    title: "Episodes start themselves",
    body: "The first allowed person to arrive opens the Episode. Nobody schedules it, and only one runs at a time.",
  },
  {
    id: "immutable",

    title: "What ended stays ended",
    body: "When an Episode closes, its attendance, recording, and transcript are immutable. History does not get rewritten.",
  },
] as const;

export function SpaceModel() {
  return (
    <section className="band band-tint" id="spaces">
      <div className="container">
        <header className="sec-head">
          <h2>
            Nobody should re-invite the same six people <span className="muted">every Tuesday.</span>
          </h2>
          <p>So Chalk splits the work into two parts. A Space is the durable place, with its members, settings, chat, and whiteboard. An Episode is one bounded run of activity inside it.</p>
        </header>

        <div className="model-visual">
          <Illustration className="model-illustration" src="/images/landing/chalk-flow-episodes-20260818.webp" width={1536} height={1024} />
          <div className="model-timeline">
            <SpaceTimeline />
          </div>
        </div>

        <ul className="points">
          {POINTS.map((point) => (
            <li className="point" key={point.id}>
              <h3>{point.title}</h3>
              <p>{point.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
