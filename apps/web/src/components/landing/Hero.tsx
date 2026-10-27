import { useId, useState, type FormEvent } from "react";

import { CopyButton } from "../site/CopyButton";
import { Icon } from "../site/Icon";
import { START_CALL_HREF } from "../site/links";
import { IS_NIGHTLY } from "../../lib/site-head";
import { Dither } from "./Dither";
import { CallPreview } from "./CallPreview";

const INSTALL = "pnpm add @q9labsai/chalk-react";

function JoinForm() {
  const id = useId();
  const [invalid, setInvalid] = useState(false);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("link");
    const { callPathFromLink } = await import("./invite-link");
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
        <label className="sr" htmlFor={id}>
          Call link or code
        </label>
        <input id={id} name="link" placeholder="Paste a call link or code" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined} onChange={() => setInvalid(false)} />
        <button className="btn" type="submit">
          Join
        </button>
      </form>
      {invalid ? (
        <p className="err" id={`${id}-error`} role="alert">
          <Icon name="alert" />
          That isn’t a Chalk link or code. A call link looks like chalkmeet.com/snap-noodle-groom-koala.
        </p>
      ) : null}
    </div>
  );
}

export function CallActions() {
  return (
    <div className="hact">
      <a className="btn pri lg" href={START_CALL_HREF}>
        <Icon name="plus" />
        Start a call
      </a>
      <JoinForm />
    </div>
  );
}

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="ctn hero-centered">
        <div className="hcopy">
          <h1 className="h1" id="hero-title">
            Calls for your team, and <span className="hl">inside your product.</span>
          </h1>
          <p className="lede">Start a call and share one link that keeps working next week. Or render the same call in your own app with a few lines of React. Chalk is open source.</p>
          <CallActions />
          <div className="hdev">
            <span className="mu">Building it into your product?</span>
            <div className="lrow cmd">
              <span>
                <i>$</i> {INSTALL}
              </span>
              <CopyButton text={INSTALL} label="Copy install command" />
            </div>
            <a className="hdocs" href="/docs/quickstart">
              Read the docs →
            </a>
          </div>
        </div>
        <div className={IS_NIGHTLY ? "hvis sky" : "hvis"}>
          {IS_NIGHTLY ? (
            <>
              <Dither kind="sky" />
              <div className="chalkstick" />
            </>
          ) : null}
          <div className="hframe">
            <CallPreview label="Interactive Q9 team call preview" />
          </div>
        </div>
      </div>
    </section>
  );
}
