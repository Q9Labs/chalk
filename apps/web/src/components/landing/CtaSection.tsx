import { CallActions } from "./Hero";
import { Dither } from "./Dither";

export function CtaSection() {
  return (
    <section className="band" id="start" aria-labelledby="cta-title">
      <div className="ctn dpanel cta-panel">
        <Dither kind="cta" />
        <h2 className="h2" id="cta-title">
          Your next call is one link away.
        </h2>
        <p className="sub">Start a call, send the link, and it stays yours. Nothing to install and nothing to schedule.</p>
        <CallActions />
      </div>
    </section>
  );
}
