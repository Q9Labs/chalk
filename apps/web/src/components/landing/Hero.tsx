import { useState, type FormEvent } from "react";

import { CopyButton } from "../site/CopyButton";
import { Icon } from "../site/Icon";
import { START_CALL_HREF } from "../site/links";
import { CallPreview } from "./CallPreview";
import { callPathFromLink } from "./invite-link";

const INSTALL = "pnpm add @q9labsai/chalk-react";

function JoinForm() {
  const [invalid, setInvalid] = useState(false);

  function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("link");
    const path = typeof value === "string" ? callPathFromLink(value, window.location.origin) : undefined;
    if (!path) {
      setInvalid(true);
      return;
    }
    window.location.assign(path);
  }

  return (
    <div className="joinwrap">
      <form className={invalid ? "join bad" : "join"} onSubmit={join} noValidate>
        <label className="sr" htmlFor="hero-join">
          Call link or code
        </label>
        <input id="hero-join" name="link" placeholder="Paste a call link or code" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-invalid={invalid} aria-describedby={invalid ? "hero-join-error" : undefined} onChange={() => setInvalid(false)} />
        <button className="btn" type="submit">
          Join
        </button>
      </form>
      {invalid ? (
        <p className="err" id="hero-join-error" role="alert">
          <Icon name="alert" />
          That isn’t a Chalk link or code. A call link looks like chalkmeet.com/abc-defg-hij.
        </p>
      ) : null}
    </div>
  );
}

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="ctn">
        <h1 className="h1" id="hero-title">
          Calls for your team, and <span className="hl">inside your product.</span>
        </h1>
        <p className="lede">Start a call and share one link that keeps working next week. Or render the same call in your own app with a few lines of React. Chalk is open source.</p>
        <div className="doors">
          <div className="door">
            <h2>Hold a call</h2>
            <p>Start one and share the link. People join from their browser, with no account and nothing to install.</p>
            <div className="drow">
              <a className="btn pri lg" href={START_CALL_HREF}>
                <Icon name="plus" />
                Start a call
              </a>
              <JoinForm />
            </div>
          </div>
          <div className="door">
            <h2>Build with Chalk</h2>
            <p>Put the same call inside your product. One React component renders it, and your server decides who gets in.</p>
            <div className="drow">
              <a className="btn pri lg" href="/docs/quickstart">
                Read the docs
              </a>
              <div className="lrow cmd">
                <span>
                  <i>$</i> {INSTALL}
                </span>
                <CopyButton text={INSTALL} label="Copy install command" />
              </div>
            </div>
          </div>
        </div>
        <div className="hvis">
          <div className="hframe wide">
            <CallPreview label="A Chalk call with four people: two cameras on, one camera off, Nora speaking" initialWidth={1190} />
          </div>
          <div className="hframe phone">
            <CallPreview label="A Chalk call on a phone with four people: two cameras on, one camera off, Nora speaking" layout="phone" width={300} initialWidth={300} />
          </div>
        </div>
      </div>
    </section>
  );
}
