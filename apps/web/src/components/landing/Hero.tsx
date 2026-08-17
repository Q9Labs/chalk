import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import PackageIcon from "@hugeicons/core-free-icons/PackageIcon";
import ServerStack01Icon from "@hugeicons/core-free-icons/ServerStack01Icon";
import { useState, type FormEvent } from "react";

import { Icon } from "./Icon";
import { resolveSpaceInviteLink } from "./invite-link";

const PROOF = [
  { id: "link", icon: Link01Icon, label: "One link that never expires" },
  { id: "self-host", icon: ServerStack01Icon, label: "Self-host the whole thing" },
  { id: "sdk", icon: PackageIcon, label: "React and React Native SDK" },
] as const;

// React and React Native share one mark, and one mark is what they get: the
// same logo drawn twice reads as a mistake, not as two platforms.
const TECHNOLOGY_MARKS = [
  { id: "typescript", src: "/brand/technology/typescript.svg", label: "TypeScript" },
  { id: "react", src: "/brand/technology/react_light.svg", label: "React and React Native" },
  { id: "cloudflare", src: "/brand/technology/cloudflare.svg", label: "Cloudflare" },
] as const;

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
    <form className="hero-invite" id="join-space" onSubmit={submitInvite} noValidate>
      <label htmlFor="invite-link">Already been sent a link?</label>
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
          placeholder="Paste it here"
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

export function Hero() {
  return (
    <>
      <section className="hero">
        <div className="container">
          <a className="hero-badge" href="/sdk-preview">
            <b>New</b>
            Put a Space inside your own product
            <span>
              <Icon glyph={ArrowRight02Icon} size={14} weight={2.2} />
            </span>
          </a>

          <h1>
            Every call ends. <span className="muted">The Space doesn&rsquo;t.</span>
          </h1>

          <p className="hero-sub">Chalk gives a team, or a product you are building, a space that outlasts the call. Video, chat, whiteboard, and files stay put between calls — on our infrastructure or on yours.</p>

          <div className="hero-ctas">
            <a href="/sign-up" className="btn btn-primary btn-lg">
              Create an account
              <Icon glyph={ArrowRight02Icon} size={17} weight={2.2} />
            </a>
            <a href="#product" className="btn btn-secondary btn-lg">
              See how it works
            </a>
          </div>

          <ul className="hero-proof">
            {PROOF.map((proof) => (
              <li key={proof.id}>
                <Icon glyph={proof.icon} size={17} weight={2} />
                {proof.label}
              </li>
            ))}
          </ul>

          <div className="hero-stage">
            <figure className="hero-frame">
              <img src="/images/marketing/chalk-speaker-view-20260801.webp" width={1586} height={992} alt="Chalk Space interface with an active speaker, Participant filmstrip, and media controls." />
            </figure>
          </div>

          {/* The invite form belongs down here rather than under the buttons:
              three stacked ways to act is a menu, not a hero. Everything above
              is for people arriving cold; this is for the one holding a link. */}
          <InviteLinkForm />
        </div>
      </section>

      <section className="trust">
        <div className="container">
          <p>Built on tools your team already runs</p>
          <div className="trust-marks">
            {TECHNOLOGY_MARKS.map((mark) => (
              <span className="trust-mark" key={mark.id}>
                <img src={mark.src} alt="" aria-hidden="true" />
                {mark.label}
              </span>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
