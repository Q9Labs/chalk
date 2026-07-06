import { Link } from "@tanstack/react-router";
import { ChalkLogo } from "./ChalkLogo";
import { VariationSwitcher } from "./VariationSwitcher";
import { ArrowIcon, BoardIcon, BoltIcon, RecordIcon, ShieldIcon, UsersIcon } from "./icons";

export function V3Bento() {
  return (
    <div className="lp3">
      <div className="lp3__main">
        <div className="lp3__wrap">
          <header className="lp3__nav">
            <ChalkLogo size={28} />
            <nav className="lp3__navlinks">
              <a href="#bento">Features</a>
              <Link to="/whiteboard">Whiteboard</Link>
              <Link to="/status">Status</Link>
            </nav>
            <Link to="/new" className="lp3__navcta">
              Start a class <ArrowIcon />
            </Link>
          </header>

          <section className="lp3__hero">
            <span className="lp3__badge">
              <b>
                <i className="lp3__dot" /> 42ms
              </b>
              Ultra-low-latency video for education
            </span>
            <h1 className="lp3__h1 lp3__display">
              A classroom that keeps up <mark>with you.</mark>
            </h1>
            <p className="lp3__sub">
              Chalk is real-time video built for teaching — fast enough that questions, answers, and
              the whole messy joy of a live class happen exactly when they should.
            </p>
            <div className="lp3__cta">
              <Link to="/new" className="lp3__btn lp3__btn--primary">
                Start a class <ArrowIcon />
              </Link>
              <Link to="/whiteboard" className="lp3__btn lp3__btn--soft">
                <BoardIcon /> Open a whiteboard
              </Link>
            </div>
          </section>

          <section className="lp3__bento" id="bento">
            <article className="lp3__cell cell-hero">
              <div>
                <h3 className="lp3__display">Sub-100ms — felt, not just measured.</h3>
                <p>
                  A global edge network delivers every frame in real time, so conversation flows the
                  way it does in a room.
                </p>
              </div>
              <div className="lp3__mock" aria-hidden>
                <div className="lp3__mockhead">
                  <span>Period 4 · Biology</span>
                  <span className="live">
                    <i className="lp3__dot" style={{ background: "#c5e5c0" }} /> 42ms
                  </span>
                </div>
                <div className="lp3__mocktiles">
                  <i className="mt1" />
                  <i className="mt2" />
                  <i className="mt3" />
                  <i className="mt4" />
                </div>
              </div>
            </article>

            <article className="lp3__cell cell-stat">
              <b>99.99%</b>
              <span>Uptime during class hours, across 120+ edge locations.</span>
            </article>

            <article className="lp3__cell cell-board">
              <span className="lp3__chip">
                <BoardIcon />
              </span>
              <h3>Live whiteboard</h3>
              <p>Every stroke, shared instantly.</p>
            </article>

            <article className="lp3__cell cell-rooms">
              <div>
                <span className="lp3__chip">
                  <UsersIcon />
                </span>
                <h3>Breakout rooms</h3>
                <p>Split into small groups and regroup in a tap.</p>
              </div>
              <div className="lp3__avatars" aria-hidden>
                <i className="av1" />
                <i className="av2" />
                <i className="av3" />
                <i className="av4" />
                <i className="av5">+21</i>
              </div>
            </article>

            <article className="lp3__cell cell-record">
              <span className="lp3__chip">
                <RecordIcon />
              </span>
              <h3>Record &amp; revisit</h3>
              <p>High-fidelity replays for anyone who missed it.</p>
            </article>

            <article className="lp3__cell cell-safe">
              <span className="lp3__chip">
                <ShieldIcon />
              </span>
              <h3>Safe by default</h3>
              <p>Encrypted rooms, teacher controls, no data sold.</p>
            </article>

            <article className="lp3__cell cell-cta">
              <h3 className="lp3__display">Ready when your class is.</h3>
              <p>Open a room, share the link, start teaching.</p>
              <div className="row">
                <Link to="/new" className="go">
                  Start a meeting <ArrowIcon />
                </Link>
                <a href="#bento" className="go ghost">
                  <BoltIcon /> See features
                </a>
              </div>
            </article>
          </section>

          <section className="lp3__strip">
            <p>Powering live learning at</p>
            <div className="lp3__logos">
              <span>Northgate High</span>
              <span>Meridian College</span>
              <span>Bright Tutors</span>
              <span>Cedar Academy</span>
              <span>Studyhall</span>
            </div>
          </section>

          <footer className="lp3__footer">
            <ChalkLogo size={24} />
            <nav className="lp3__footlinks">
              <Link to="/privacy">Privacy</Link>
              <Link to="/terms">Terms</Link>
              <Link to="/status">Status</Link>
            </nav>
            <span className="lp3__copy">© {new Date().getFullYear()} Chalk</span>
          </footer>
        </div>
      </div>

      <VariationSwitcher />
    </div>
  );
}
