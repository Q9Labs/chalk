import { useState, type FormEvent } from "react";

const TECHNOLOGY_MARKS = {
  typescript: { src: "/brand/technology/typescript.svg", label: "TypeScript" },
  react: { src: "/brand/technology/react_light.svg", label: "React" },
  "react-native": { src: "/brand/technology/react_light.svg", label: "React Native" },
  cloudflare: { src: "/brand/technology/cloudflare.svg", label: "Cloudflare" },
} as const;

type Technology = keyof typeof TECHNOLOGY_MARKS;

/** Returns a safe Space URL without moving invite credentials into a query string. */
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
          <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" />
        </a>
        <nav className="nav-links" aria-label="Product navigation">
          <a href="#product">Product</a>
          <a href="#performance">Performance</a>
          <a href="#self-host">Self-host</a>
          <a href="#features">Features</a>
        </nav>
        <nav className="nav-actions" aria-label="Account navigation">
          <a className="nav-dashboard" href="/home">
            Dashboard
          </a>
          <a className="nav-sign-in" href="/sign-in">
            Sign in
          </a>
          <a href="/sign-up" className="btn btn-primary nav-cta">
            Get started
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
      setInviteError("Paste a valid Space invite link, such as /space/design-lab#your-invite-token.");
      return;
    }

    window.location.assign(destination);
  }

  return (
    <form className="hero-invite" id="join-space" onSubmit={submitInvite} noValidate aria-describedby={inviteError ? "invite-link-error" : "invite-link-help"}>
      <label htmlFor="invite-link">Have an invite link?</label>
      <div className="hero-invite-row">
        <input
          id="invite-link"
          name="invite-link"
          type="url"
          value={inviteLink}
          onChange={(event) => {
            setInviteLink(event.target.value);
            if (inviteError) setInviteError(undefined);
          }}
          placeholder="Paste a Space invite link"
          autoComplete="url"
          spellCheck={false}
          aria-invalid={inviteError ? "true" : "false"}
          aria-describedby={inviteError ? "invite-link-help invite-link-error" : "invite-link-help"}
        />
        <button type="submit" className="btn btn-secondary">
          Join a Space
        </button>
      </div>
      <p className="hero-invite-help" id="invite-link-help">
        Use a link with a <code>/space/&lt;slug&gt;</code> path. The invite token stays in the link hash.
      </p>
      {inviteError ? (
        <p className="hero-invite-error" id="invite-link-error" role="alert">
          {inviteError}
        </p>
      ) : null}
    </form>
  );
}

export function Hero() {
  return (
    <section className="hero">
      <div className="container hero-inner">
        <div className="hero-copy">
          <p className="hero-kicker">Real-time collaboration, made dependable.</p>
          <h1>
            Bring people together.
            <span className="hero-highlight">Keep them in flow.</span>
          </h1>
          <p className="hero-sub">Chalk gives your product a dependable Space for every conversation, shared artifact, and live moment.</p>
          <div className="hero-ctas">
            <a href="/sign-up" className="btn btn-primary">
              Create an Account
            </a>
            <a href="/home" className="btn btn-secondary">
              Open Dashboard
            </a>
          </div>
          <InviteLinkForm />
        </div>

        <figure className="hero-product">
          <div className="hero-product-wash" aria-hidden="true" />
          <img src="/images/marketing/chalk-speaker-view-20260801.webp" width={1586} height={992} alt="Chalk Space interface with an active speaker, Participant filmstrip, and media controls." />
        </figure>
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
