import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import Layers01Icon from "@hugeicons/core-free-icons/Layers01Icon";
import LockIcon from "@hugeicons/core-free-icons/LockIcon";
import RepeatIcon from "@hugeicons/core-free-icons/RepeatIcon";

import { Icon } from "./Icon";
import { Illustration } from "./Illustration";
import { SpaceTimeline } from "./visuals";

const POINTS = [
  {
    id: "link",
    icon: Link01Icon,
    title: "One link, for good",
    body: "A join link names the Space, never a call. Send it once and it keeps working next week.",
  },
  {
    id: "episodes",
    icon: RepeatIcon,
    title: "Episodes start themselves",
    body: "The first allowed person to arrive opens the Episode. Nobody schedules it, and only one runs at a time.",
  },
  {
    id: "immutable",
    icon: LockIcon,
    title: "What ended stays ended",
    body: "When an Episode closes, its attendance, recording, and transcript are immutable. History does not get rewritten.",
  },
] as const;

export function SpaceModel() {
  return (
    <section className="band band-tint" id="spaces">
      <div className="container">
        <header className="sec-head">
          <span className="eyebrow">
            <Icon glyph={Layers01Icon} size={15} weight={2} />
            The model
          </span>
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
              <span className="point-icon">
                <Icon glyph={point.icon} size={19} weight={2} />
              </span>
              <h3>{point.title}</h3>
              <p>{point.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
