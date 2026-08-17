import PackageIcon from "@hugeicons/core-free-icons/PackageIcon";
import Pulse01Icon from "@hugeicons/core-free-icons/Pulse01Icon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import UserGroupIcon from "@hugeicons/core-free-icons/UserGroupIcon";
import Video01Icon from "@hugeicons/core-free-icons/Video01Icon";

import { Icon } from "./Icon";

const GROUPS = [
  {
    id: "identity",
    icon: UserGroupIcon,
    title: "Space and identity",
    items: ["Space lifecycle API", "Space, Episode, Participant model", "Link and token admission", "Roles and capabilities", "Tenants and memberships", "API keys with rotation", "Audit logs"],
  },
  {
    id: "sync",
    icon: Pulse01Icon,
    title: "Realtime sync",
    items: ["SyncEngine v1 client", "Postgres-durable runtime", "Bounded recovery and replay", "Receipts and backpressure"],
  },
  {
    id: "media",
    icon: Video01Icon,
    title: "Media",
    items: ["Provider-neutral media plane", "Cloudflare SFU adapter", "RealtimeKit adapter for native", "Short-lived participant credentials"],
  },
  {
    id: "sdk",
    icon: PackageIcon,
    title: "SDK surfaces",
    items: ["Turnkey <Chalk /> component", "Entrance and device check", "Chat, reactions, participants", "Screen share", "Recording and transcript UI", "Whiteboard canvas with math", "Server-only Promise SDK", "Generated types from one contract"],
  },
  {
    id: "ops",
    icon: Settings01Icon,
    title: "Operations",
    items: ["Versioned webhooks with signing", "Delivery retries and idempotency", "Journey IDs and trace context", "Liveness and readiness", "OpenTelemetry and Grafana"],
  },
] as const;

export function Platform() {
  return (
    <section className="band" id="platform">
      <div className="container">
        <header className="sec-head">
          <span className="eyebrow">
            <Icon glyph={SparklesIcon} size={15} weight={2} />
            Shipped
          </span>
          <h2>
            Everything here <span className="muted">already works.</span>
          </h2>
          <p>Built and covered by tests in the Chalk repository, across the hosted product and the SDK. Nothing on this list is a roadmap item.</p>
        </header>

        <div className="chip-groups">
          {GROUPS.map((group) => (
            <section className="chip-group" key={group.id}>
              <h3>
                <Icon glyph={group.icon} size={15} weight={2} />
                {group.title}
              </h3>
              <ul className="chips">
                {group.items.map((item) => (
                  <li className="chip" key={item}>
                    <Icon glyph={Tick02Icon} size={15} weight={2.4} />
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <p className="fine-print platform-note">Still being qualified: recording capture at scale, hosted transcription end to end, a self-hosted SFU adapter, and enterprise SSO.</p>
      </div>
    </section>
  );
}
