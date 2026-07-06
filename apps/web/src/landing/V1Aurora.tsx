import { Link } from "@tanstack/react-router";
import { ChalkLogo } from "./ChalkLogo";
import { VariationSwitcher } from "./VariationSwitcher";
import {
  ArrowIcon,
  BoardIcon,
  BoltIcon,
  GlobeIcon,
  PlayIcon,
  RecordIcon,
  ShieldIcon,
  UsersIcon,
} from "./icons";

const NAV = [
  { label: "Product", href: "#features" },
  { label: "For classrooms", href: "#classrooms" },
  { label: "Latency", href: "#metrics" },
  { label: "Status", to: "/status" },
] as const;

export function V1Aurora() {
  return (
    <div className="lp1">
      <div className="lp1__aurora" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <div className="lp1__grid" aria-hidden />
      <div className="lp1__veil" aria-hidden />

      <div className="lp1__main">
        <div className="lp1__wrap">
          <header className="lp1__nav">
            <div className="lp1__navpill">
              <ChalkLogo size={28} />
              <nav className="lp1__navlinks">
                {NAV.map((item) =>
                  "to" in item ? (
                    <Link key={item.label} to={item.to}>
                      {item.label}
                    </Link>
                  ) : (
                    <a key={item.label} href={item.href}>
                      {item.label}
                    </a>
                  ),
                )}
              </nav>
              <div className="lp1__navright">
                <Link to="/new" className="lp1__btn lp1__btn--primary">
                  Start a meeting
                </Link>
              </div>
            </div>
          </header>

          <section className="lp1__hero">
            <span className="lp1__badge">
              <b>
                <i className="lp1__pulse" /> Live
              </b>
              Real-time classrooms · sub-100ms
            </span>
            <h1 className="lp1__h1">
              Teach like you're <em>in the room</em>, from anywhere.
            </h1>
            <p className="lp1__sub">
              Chalk is ultra-low-latency video built for education. No awkward pauses, no talking
              over each other — just the natural back-and-forth of a real classroom, streamed the
              moment it happens.
            </p>
            <div className="lp1__cta">
              <Link to="/new" className="lp1__btn lp1__btn--primary lp1__btn--lg">
                Start a class <ArrowIcon />
              </Link>
              <a href="#stage" className="lp1__btn lp1__btn--ghost lp1__btn--lg">
                <PlayIcon /> Watch a lesson
              </a>
            </div>
            <p className="lp1__note">Free to start · No download · Works in any browser</p>
          </section>

          <section className="lp1__stage" id="stage">
            <figure className="lp1__mock">
              <div className="lp1__mockbar">
                <div className="lp1__dots">
                  <i />
                  <i />
                  <i />
                </div>
                <span className="lp1__mocktitle">Period 4 · Organic Chemistry</span>
                <span className="lp1__latency">
                  <i className="lp1__pulse" style={{ background: "var(--chalk-green-soft)" }} />
                  42ms round-trip
                </span>
              </div>
              <div className="lp1__tiles">
                <figure className="lp1__tile lp1__tile--main t-blue">
                  <b>Ms. Rivera</b>
                  <figcaption>Presenting · sharing whiteboard</figcaption>
                </figure>
                <figure className="lp1__tile t-green">
                  <figcaption>Amara</figcaption>
                </figure>
                <figure className="lp1__tile t-pink">
                  <figcaption>Diego · hand raised ✋</figcaption>
                </figure>
              </div>
              <div className="lp1__mockctl" aria-hidden>
                <i />
                <i />
                <i />
                <i />
              </div>
            </figure>
          </section>

          <section className="lp1__proof">
            <p>Trusted in classrooms, lecture halls, and study groups</p>
            <div className="lp1__logos">
              <span>Northgate High</span>
              <span>Meridian College</span>
              <span>Bright Tutors</span>
              <span>Studyhall</span>
              <span>Cedar Academy</span>
            </div>
          </section>

          <section className="lp1__section" id="features">
            <p className="lp1__eyebrow">Built for how teaching actually feels</p>
            <h2 className="lp1__h2">Every millisecond you save is a moment of real connection.</h2>
            <p className="lp1__lead">
              We rebuilt the media stack from the ground up so conversation flows, questions land,
              and nobody freezes mid-sentence.
            </p>

            <div className="lp1__features">
              <article className="lp1__card lp1__card--wide">
                <span className="lp1__ico ico-green">
                  <BoltIcon />
                </span>
                <div>
                  <h3>Ultra-low latency, everywhere</h3>
                  <p>
                    A global edge network keeps round-trip under 100ms so a raised hand and a "yes,
                    go ahead" happen at the speed of a real room — not a satellite call.
                  </p>
                </div>
              </article>
              <article className="lp1__card">
                <span className="lp1__ico ico-blue">
                  <BoardIcon />
                </span>
                <h3>Live whiteboard</h3>
                <p>Sketch, annotate, and solve together on an infinite shared canvas.</p>
              </article>
              <article className="lp1__card">
                <span className="lp1__ico ico-yellow">
                  <UsersIcon />
                </span>
                <h3>Breakout groups</h3>
                <p>Split a class into small rooms in one tap, then pull everyone back instantly.</p>
              </article>
              <article className="lp1__card">
                <span className="lp1__ico ico-pink">
                  <RecordIcon />
                </span>
                <h3>Record &amp; revisit</h3>
                <p>Every lesson is captured in crisp quality for students who need a second pass.</p>
              </article>
              <article className="lp1__card">
                <span className="lp1__ico ico-blue">
                  <ShieldIcon />
                </span>
                <h3>Safe by default</h3>
                <p>Encrypted rooms, teacher controls, and no data sold. Ever.</p>
              </article>
            </div>
          </section>

          <section className="lp1__section" id="metrics" style={{ paddingTop: 0 }}>
            <div className="lp1__metrics">
              <div className="lp1__metric">
                <b>42ms</b>
                <span>Median round-trip latency</span>
              </div>
              <div className="lp1__metric">
                <b>120+</b>
                <span>Edge locations worldwide</span>
              </div>
              <div className="lp1__metric">
                <b>99.99%</b>
                <span>Class-time uptime</span>
              </div>
              <div className="lp1__metric">
                <b>250</b>
                <span>Students per live room</span>
              </div>
            </div>
          </section>

          <section className="lp1__section" id="classrooms" style={{ paddingTop: 0 }}>
            <div className="lp1__final">
              <h2>Your next class starts in one click.</h2>
              <p>
                No accounts to wrangle, no installs to chase. Open a room, share the link, and start
                teaching.
              </p>
              <div className="lp1__cta">
                <Link to="/new" className="lp1__btn lp1__btn--primary lp1__btn--lg">
                  Start a meeting <ArrowIcon />
                </Link>
                <Link to="/whiteboard" className="lp1__btn lp1__btn--ghost lp1__btn--lg">
                  <BoardIcon /> Open a whiteboard
                </Link>
              </div>
            </div>
          </section>
        </div>

        <footer className="lp1__footer">
          <div className="lp1__wrap lp1__footrow">
            <ChalkLogo size={24} />
            <nav className="lp1__footlinks">
              <Link to="/privacy">Privacy</Link>
              <Link to="/terms">Terms</Link>
              <Link to="/status">Status</Link>
              <a href="#features">Product</a>
            </nav>
            <span className="lp1__copy">
              <GlobeIcon
                style={{ width: 14, height: 14, display: "inline", verticalAlign: "-2px", marginRight: 6 }}
              />
              © {new Date().getFullYear()} Chalk
            </span>
          </div>
        </footer>
      </div>

      <VariationSwitcher />
    </div>
  );
}
