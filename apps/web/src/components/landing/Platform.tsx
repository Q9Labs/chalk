import { Illustration } from "./Illustration";

const GROUPS = [
  {
    id: "identity",

    title: "Space and access",
    body: "Lifecycle, identity, admission, roles, tenants, keys, and audit are one tested control plane.",
  },
  {
    id: "realtime",

    title: "Realtime and media",
    body: "Durable sync, bounded recovery, backpressure, and provider-neutral media work across web and native.",
  },
  {
    id: "sdk",

    title: "SDK surfaces",
    body: "Turnkey and composable React surfaces cover entrance, media, chat, recording, and whiteboard.",
  },
  {
    id: "ops",

    title: "Operations",
    body: "Signed webhooks, retries, journey tracing, health checks, and telemetry ship with the platform.",
  },
] as const;

export function Platform() {
  return (
    <section className="band" id="platform">
      <div className="container">
        <header className="sec-head">
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
