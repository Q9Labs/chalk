import ArrowDataTransferHorizontalIcon from "@hugeicons/core-free-icons/ArrowDataTransferHorizontalIcon";
import FlashIcon from "@hugeicons/core-free-icons/FlashIcon";
import Timer02Icon from "@hugeicons/core-free-icons/Timer02Icon";
import Video01Icon from "@hugeicons/core-free-icons/Video01Icon";

import { Icon } from "./Icon";

const STATS = [
  { id: "join", icon: FlashIcon, num: "<1s", what: "Click to media", how: "First frame at p50.", tone: "blue" },
  { id: "control", icon: ArrowDataTransferHorizontalIcon, num: "<100ms", what: "Control signal", how: "Sync plane at p95.", tone: "green" },
  { id: "glass", icon: Video01Icon, num: "<200ms", what: "Glass to glass", how: "Same-region media.", tone: "yellow" },
] as const;

export function Performance() {
  return (
    <section className="band" id="speed">
      <div className="container">
        <header className="sec-head">
          <span className="eyebrow">
            <Icon glyph={Timer02Icon} size={15} weight={2} />
            Latency
          </span>
          <h2>
            Every step on the way in <span className="muted">has a number it has to beat.</span>
          </h2>
          <p>Latency is a design constraint here, not something measured after the fact. These are the three that sit between pressing a button and seeing a face.</p>
        </header>

        <ul className="speed-stats">
          {STATS.map((stat) => (
            <li key={stat.id} className={`speed-stat card speed-stat-${stat.tone}`}>
              <span className="speed-stat-icon">
                <Icon glyph={stat.icon} size={19} weight={2} />
              </span>
              <strong>{stat.num}</strong>
              <b>{stat.what}</b>
              <span className="speed-stat-how">{stat.how}</span>
            </li>
          ))}
        </ul>

        <p className="fine-print speed-note">These are the budgets Chalk designs against. They are not a published service level agreement.</p>
      </div>
    </section>
  );
}
