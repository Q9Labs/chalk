import { useState, type FormEvent } from "react";

const TECHNOLOGY_MARKS = {
  typescript: { src: "/brand/technology/typescript.svg", label: "TypeScript" },
  react: { src: "/brand/technology/react_light.svg", label: "React" },
  "react-native": { src: "/brand/technology/react_light.svg", label: "React Native" },
  cloudflare: { src: "/brand/technology/cloudflare.svg", label: "Cloudflare" },
} as const;

const PARTICIPANTS = [
  { name: "Alex Morgan", position: "52% 17%", status: "good" },
  { name: "Priya Shah", position: "20% 82%", status: "muted" },
  { name: "Marcus Lee", position: "78% 84%", status: "good" },
  { name: "Jordan Kim", position: "62% 34%", status: "warning" },
] as const;

type Technology = keyof typeof TECHNOLOGY_MARKS;

export function resolveSpaceInviteLink(value: string, origin: string): string | undefined {
  const input = value.trim();
  if (!input || input.startsWith("//") || (!input.startsWith("/") && !/^https?:\/\//i.test(input))) return undefined;

  let url: URL;
  try {
    url = new URL(input, origin);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.search || url.username || url.password) return undefined;
  if (!/^\/space\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(url.pathname)) return undefined;

  return url.toString();
}

export function SiteNav() {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <a href="/" className="nav-logo" aria-label="Chalk home">
          <img src="/brand/chalk/chalk-logo-on-dark.svg" alt="Chalk" />
        </a>
        <nav className="nav-links" aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="/sdk-preview">SDKs</a>
          <a href="/docs">Docs</a>
        </nav>
        <nav className="nav-actions" aria-label="Account navigation">
          <a className="nav-sign-in" href="/sign-in">
            Sign in
          </a>
          <a href="/sign-up" className="btn btn-primary nav-cta">
            Create account
          </a>
        </nav>
      </div>
    </header>
  );
}

function TechnologyMark({ technology }: { technology: Technology }) {
  const mark = TECHNOLOGY_MARKS[technology];

  return (
    <span className={`hero-tech-mark hero-tech-${technology}`} role="img" aria-label={mark.label}>
      <img src={mark.src} alt="" aria-hidden="true" />
    </span>
  );
}

function InviteLinkForm() {
  const [inviteLink, setInviteLink] = useState("");
  const [inviteError, setInviteError] = useState<string | undefined>();

  function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const destination = resolveSpaceInviteLink(inviteLink, window.location.origin);
    if (!destination) {
      setInviteError("Paste a valid Space invite link with a /space/<slug> path.");
      return;
    }

    window.location.assign(destination);
  }

  return (
    <form className="hero-invite" id="join-space" onSubmit={submitInvite} noValidate aria-label="Join a Space">
      <label className="visually-hidden" htmlFor="invite-link">
        Paste invite link
      </label>
      <div className="hero-invite-row">
        <span className="hero-invite-icon" aria-hidden="true">
          ↗
        </span>
        <input
          id="invite-link"
          name="invite-link"
          type="url"
          value={inviteLink}
          onChange={(event) => {
            setInviteLink(event.target.value);
            if (inviteError) setInviteError(undefined);
          }}
          placeholder="Paste invite link"
          autoComplete="url"
          spellCheck={false}
          aria-invalid={inviteError ? "true" : "false"}
          aria-describedby={inviteError ? "invite-link-error" : undefined}
        />
        <button type="submit" className="hero-invite-submit">
          Join
        </button>
      </div>
      {inviteError ? (
        <p className="hero-invite-error" id="invite-link-error" role="alert">
          {inviteError}
        </p>
      ) : null}
    </form>
  );
}

function ProductPreview() {
  return (
    <figure className="hero-product">
      <div className="product-window" aria-hidden="true">
        <div className="product-toolbar">
          <div className="product-space-name">
            <span className="product-space-icon">#</span>
            <strong>Q3 Design Sync</strong>
            <span className="product-chevron">⌄</span>
          </div>
          <div className="product-presence">
            <span className="product-presence-icon">♧</span>
            <span>12</span>
            <span className="product-separator" />
            <span className="product-live-dot" />
            <span>Live</span>
          </div>
          <div className="product-toolbar-actions">
            <span>♢</span>
            <span>♧</span>
            <span>◯</span>
            <span>•••</span>
            <span className="product-end">⌕</span>
          </div>
        </div>

        <div className="product-stage">
          <div className="product-participants">
            {PARTICIPANTS.map((participant, index) => (
              <article className={`participant-card participant-card-${index + 1}`} key={participant.name}>
                <img src="/images/marketing/chalk-speaker-view-20260801.webp" alt="" style={{ objectPosition: participant.position }} />
                <span className="participant-name">{participant.name}</span>
                <span className={`participant-signal participant-signal-${participant.status}`} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </article>
            ))}
          </div>

          <aside className="connection-panel">
            <h3>
              <span aria-hidden="true">⌁</span> Connection quality
            </h3>
            <strong>Excellent</strong>
            <p>
              Real-time <span>•</span> Stable
            </p>
            <dl>
              <div>
                <dt>Latency</dt>
                <dd>28 ms</dd>
              </div>
              <div>
                <dt>Jitter</dt>
                <dd>6 ms</dd>
              </div>
              <div>
                <dt>Packet loss</dt>
                <dd>0.2%</dd>
              </div>
            </dl>
            <span className="connection-details">
              View details <span aria-hidden="true">↗</span>
            </span>
          </aside>
        </div>

        <div className="product-controls">
          <span className="product-control-active">
            <b aria-hidden="true">♩</b> Mic
          </span>
          <span>
            <b aria-hidden="true">▣</b> Camera
          </span>
          <span>
            <b aria-hidden="true">▧</b> Share
          </span>
          <span>
            <b aria-hidden="true">☺</b> Reactions
          </span>
          <span>
            <b aria-hidden="true">◯</b> Chat
          </span>
          <span>
            <b aria-hidden="true">♧</b> People
          </span>
        </div>
      </div>
      <figcaption className="visually-hidden">A Chalk Space with four Participants, live connection quality, and collaboration controls.</figcaption>
    </figure>
  );
}

export function Hero() {
  return (
    <section className="hero">
      <div className="container hero-inner">
        <header className="hero-heading">
          <h1>
            <span>Real-time spaces,</span>
            <span className="hero-highlight">without the waiting.</span>
          </h1>
          <p>Build, join, and scale real-time experiences with voice, video, and messaging that just work—at global scale.</p>
        </header>

        <div className="hero-actions">
          <a href="/home" className="btn btn-primary hero-create">
            Create a Space
          </a>
          <InviteLinkForm />
        </div>

        <ProductPreview />
      </div>

      <div className="container hero-proof" aria-label="Technologies used by Chalk">
        <TechnologyMark technology="typescript" />
        <TechnologyMark technology="react" />
        <TechnologyMark technology="react-native" />
        <TechnologyMark technology="cloudflare" />
      </div>
    </section>
  );
}
