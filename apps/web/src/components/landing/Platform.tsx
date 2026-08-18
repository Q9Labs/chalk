import PackageIcon from "@hugeicons/core-free-icons/PackageIcon";
import Pulse01Icon from "@hugeicons/core-free-icons/Pulse01Icon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/UserGroupIcon";

import { Icon } from "./Icon";
import { Illustration } from "./Illustration";

const GROUPS = [
  {
    id: "identity",
    icon: UserGroupIcon,
    title: "Space and access",
    body: "Lifecycle, identity, admission, roles, tenants, keys, and audit are one tested control plane.",
  },
  {
    id: "realtime",
    icon: Pulse01Icon,
    title: "Realtime and media",
    body: "Durable sync, bounded recovery, backpressure, and provider-neutral media work across web and native.",
  },
  {
    id: "sdk",
    icon: PackageIcon,
    title: "SDK surfaces",
    body: "Turnkey and composable React surfaces cover entrance, media, chat, recording, and whiteboard.",
  },
  {
    id: "ops",
    icon: Settings01Icon,
    title: "Operations",
    body: "Signed webhooks, retries, journey tracing, health checks, and telemetry ship with the platform.",
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
          <p>Twenty-eight shipped capabilities, distilled into four working systems. Built and covered by tests across the hosted product and SDK.</p>
        </header>

        <div className="platform-layout">
          <div className="platform-illustration card">
            <Illustration src="/images/landing/chalk-flow-platform-20260818.webp" width={1448} height={1086} />
          </div>

          <div className="capability-groups">
            {GROUPS.map((group) => (
              <section className="capability-group card" key={group.id}>
                <span className="capability-icon">
                  <Icon glyph={group.icon} size={18} weight={2} />
                </span>
                <h3>{group.title}</h3>
                <p>{group.body}</p>
              </section>
            ))}
          </div>
        </div>

        <p className="fine-print platform-note">Still being qualified: recording capture at scale, hosted transcription end to end, a self-hosted SFU adapter, and enterprise SSO.</p>
      </div>
    </section>
  );
}
