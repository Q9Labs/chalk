import { Link } from "@tanstack/react-router";
import { ChalkLogo } from "./ChalkLogo";
import { VariationSwitcher } from "./VariationSwitcher";
import { ArrowIcon, BoardIcon } from "./icons";

/** Hand-drawn chalk underline stroke. */
function Underline() {
  return (
    <svg viewBox="0 0 300 24" preserveAspectRatio="none" aria-hidden>
      <path d="M4 15 C 70 6, 150 5, 210 11 S 286 18, 296 9" />
    </svg>
  );
}

export function V2Editorial() {
  return (
    <div className="lp2">
      <div className="lp2__main">
        <div className="lp2__wrap">
          <header className="lp2__nav">
            <ChalkLogo size={28} />
            <nav className="lp2__navlinks">
              <a href="#features">Features</a>
              <a href="#board">Whiteboard</a>
              <a href="#voices">Voices</a>
              <Link to="/status">Status</Link>
              <Link to="/new" className="lp2__navcta">
                Start a class <ArrowIcon />
              </Link>
            </nav>
          </header>

          <section className="lp2__hero">
            <div>
              <p className="lp2__eyebrow">Ultra-low-latency video for education</p>
              <h1 className="lp2__h1 lp2__serif">
                The classroom,{" "}
                <span className="lp2__mark">
                  without the <i>lag</i>
                  <Underline />
                </span>
                .
              </h1>
              <p className="lp2__lede">
                Chalk streams your lessons the instant they happen — under 100 milliseconds, edge to
                edge. Questions land on time, discussions overlap naturally, and teaching feels human
                again.
              </p>
              <div className="lp2__actions">
                <Link to="/new" className="lp2__btn">
                  Start a class <ArrowIcon />
                </Link>
                <a href="#board" className="lp2__textlink">
                  See the whiteboard <ArrowIcon />
                </a>
              </div>
            </div>

            <div className="lp2__figure">
              <div className="lp2__frame">
                <div className="lp2__framecap">
                  <b>Mr. Osei · Live now</b>
                  <span>World History · 28 students</span>
                </div>
              </div>
              <div className="lp2__note-chip">
                <span className="dot" />
                <b>42ms</b>
              </div>
              <span className="lp2__hand-note">real-time!</span>
            </div>
          </section>

          <div className="lp2__ticker" aria-hidden>
            <span className="on">Lectures</span>
            <span>·</span>
            <span>Office hours</span>
            <span>·</span>
            <span className="on">Tutoring</span>
            <span>·</span>
            <span>Seminars</span>
            <span>·</span>
            <span className="on">Study groups</span>
            <span>·</span>
            <span>Labs</span>
            <span>·</span>
            <span className="on">Language classes</span>
          </div>

          <section className="lp2__section" id="features">
            <div className="lp2__sechead">
              <p className="lp2__eyebrow">Why it feels different</p>
              <h2 className="lp2__h2 lp2__serif">
                Small delays break conversation. So we removed them.
              </h2>
            </div>
            <div className="lp2__list">
              <article className="lp2__item">
                <div className="lp2__num">01</div>
                <h3>Real-time by design</h3>
                <p>
                  A purpose-built media pipeline keeps round-trip under 100ms so nobody talks over
                  the moment that already passed.
                </p>
              </article>
              <article className="lp2__item">
                <div className="lp2__num u-blue">02</div>
                <h3>An infinite whiteboard</h3>
                <p>
                  Work problems, diagram ideas, and annotate together on a shared canvas that never
                  runs out of room.
                </p>
              </article>
              <article className="lp2__item">
                <div className="lp2__num u-yellow">03</div>
                <h3>Rooms for every group</h3>
                <p>
                  Break a class into small circles and gather everyone back the second the exercise
                  is done.
                </p>
              </article>
              <article className="lp2__item">
                <div className="lp2__num u-pink">04</div>
                <h3>Recorded for later</h3>
                <p>
                  Every session is saved in high fidelity, so a student who missed it can catch up
                  word for word.
                </p>
              </article>
            </div>
          </section>

          <section id="board">
            <div className="lp2__board">
              <div className="lp2__board-grid">
                <div>
                  <p className="lp2__eyebrow">The shared board</p>
                  <h2>Drawn together, in the same breath.</h2>
                  <p>
                    Sketch a diagram and your class sees each stroke as you make it — no lag between
                    the chalk and the idea. Hand the pen to a student and let them show their work.
                  </p>
                  <Link to="/whiteboard" className="lp2__board-cta">
                    <BoardIcon /> Open a whiteboard
                  </Link>
                </div>
                <div className="lp2__sketch">
                  <span className="a a1">y = mx + b</span>
                  <span className="lp2__hand">solve together</span>
                  <span className="a a2">nice! ✓</span>
                </div>
              </div>
            </div>
          </section>

          <section className="lp2__quote" id="voices">
            <blockquote className="lp2__serif">
              “My students stopped saying <i>‘you cut out’</i>.”
            </blockquote>
            <p className="lp2__cite">
              <b>Dr. Lena Park</b> — Lecturer, Meridian College
            </p>
          </section>

          <div className="lp2__stats">
            <div className="lp2__stat">
              <b className="lp2__serif">42ms</b>
              <span>Median round-trip latency</span>
            </div>
            <div className="lp2__stat">
              <b className="lp2__serif">120+</b>
              <span>Edge locations worldwide</span>
            </div>
            <div className="lp2__stat">
              <b className="lp2__serif">99.99%</b>
              <span>Uptime during class hours</span>
            </div>
          </div>

          <footer className="lp2__footer">
            <ChalkLogo size={24} />
            <nav className="lp2__footlinks">
              <Link to="/privacy">Privacy</Link>
              <Link to="/terms">Terms</Link>
              <Link to="/status">Status</Link>
            </nav>
            <span className="lp2__copy">© {new Date().getFullYear()} Chalk</span>
          </footer>
        </div>
      </div>

      <VariationSwitcher />
    </div>
  );
}
