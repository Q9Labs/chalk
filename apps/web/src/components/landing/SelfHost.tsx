import ServerStack01Icon from "@hugeicons/core-free-icons/ServerStack01Icon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";

import { Icon } from "./Icon";
import { StackVisual } from "./visuals";

const CLAIMS = [
  { id: "deploy", text: "The API, the sync runtime, and Postgres run on your machines, with a deployment we run ourselves and keep documented." },
  { id: "postgres", text: "No vendor-only database features, so standard Postgres is enough. Redis only ever makes things faster, never authoritative." },
  { id: "keys", text: "You hold the signing keys. Access grants are minted on your server and passed through the browser untouched." },
] as const;

export function SelfHost() {
  return (
    <section className="band band-tint" id="self-host">
      <div className="container">
        <header className="sec-head">
          <span className="eyebrow">
            <Icon glyph={ServerStack01Icon} size={15} weight={2} />
            Portability
          </span>
          <h2>
            The parts you would want to replace <span className="muted">are the parts we made replaceable.</span>
          </h2>
          <p>Media providers and realtime plumbing sit behind contracts instead of running through every component, so the thing you deploy does not become the thing you are stuck with.</p>
        </header>

        <div className="stack-layout">
          <StackVisual />

          <div className="stack-copy">
            <ul className="stack-claims">
              {CLAIMS.map((claim) => (
                <li key={claim.id}>
                  <Icon glyph={Tick02Icon} size={18} weight={2.4} />
                  <span>{claim.text}</span>
                </li>
              ))}
            </ul>

            <p className="fine-print">Cloudflare is the media adapter today. Running the SFU itself on your own hardware needs an adapter that is not finished.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
