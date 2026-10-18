import { Avatar } from "../site/Avatar";
import { CodeBlock } from "../site/CodeBlock";
import { Icon } from "../site/Icon";
import { CallPreview } from "./CallPreview";

const EMBED_SOURCE = `import { Chalk } from "@q9labsai/chalk-react";

export function TeamCall() {
  return (
    <Chalk
      space="q9-team"
      getAccess={getAccess}
    />
  );
}`;

const SERVER_SOURCE = `import { createChalkServerClient } from "@q9labsai/chalk-client/server";

const chalk = createChalkServerClient({
  apiKey: process.env.CHALK_API_KEY!,
  tenantId: process.env.CHALK_TENANT_ID!,
});

// Let a signed-in student into today's class.
const { access } = await chalk.participants.admit(
  space.id, episode.id, { name: "Ari", role: "collaborator" },
);`;

const CLASS_CALL = [
  { name: "Lena Vogel", camera: true, speaking: true },
  { name: "Ari Cohen", camera: true, you: true },
  { name: "Omar Farouk", camera: false },
  { name: "June Park", camera: true, muted: true },
] as const;

const DOC_LINKS = [
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/docs/webhooks", label: "Webhooks" },
  { href: "/docs", label: "Why Chalk" },
] as const;

export function EmbedSection() {
  return (
    <section className="band" id="developers" aria-labelledby="embed-title">
      <div className="ctn split">
        <div>
          <h2 className="h2" id="embed-title">
            Put the call in your product.
          </h2>
          <p className="sub">
            <code className="ic">&lt;Chalk /&gt;</code> renders the whole call: the entrance, the stage, chat, the board and the controls. Your server creates each person’s access, so you decide who gets in.
          </p>
          <div style={{ marginTop: 32 }}>
            <CodeBlock
              label="Embed code"
              tabs={[
                { label: "React", language: "TSX", source: EMBED_SOURCE },
                { label: "Server", language: "TypeScript", source: SERVER_SOURCE },
              ]}
            />
          </div>
          <nav className="links" aria-label="Developer docs">
            {DOC_LINKS.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
                <Icon name="arrowR" />
              </a>
            ))}
          </nav>
        </div>
        <figure className="host" aria-label="The Chalk call inside a tutoring app">
          <div className="hostbar">
            <b>Lumen Tutoring</b>
            <span>Classes</span>
            <span>Students</span>
            <span className="when-wide">Schedule</span>
            <Avatar name="Ari Cohen" size={24} />
          </div>
          <div className="hostin">
            <h4>
              Algebra 7B<span>Today, 16:00</span>
            </h4>
            <CallPreview label="The same call, rendered by the Chalk component inside the tutoring app" name="Algebra 7B" time="08:41" people={CLASS_CALL} initialWidth={633} height={860} />
          </div>
        </figure>
      </div>
    </section>
  );
}
