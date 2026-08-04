import { Link } from "@tanstack/react-router";
import { Icon } from "./DashboardShell";
import { recentArtifacts, recentEpisodes, spaces } from "./dashboard-data";

export function ProductHome() {
  return (
    <div className="dashboard-page home-page">
      <header className="dashboard-page-header home-heading">
        <div>
          <p className="eyebrow">Tuesday, August 4</p>
          <h1>Continue where you left off.</h1>
          <p>Spaces keep the work together. Episodes move it forward.</p>
        </div>
        <form className="quick-join" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="join-code">Quick join</label>
          <div>
            <input id="join-code" placeholder="Paste a link or code" />
            <button type="submit" aria-label="Join Episode">
              <Icon name="arrow" />
            </button>
          </div>
        </form>
      </header>

      <section className="home-section">
        <div className="section-title-row">
          <h2>Your Spaces</h2>
          <Link to="/spaces">
            See all <Icon name="arrow" />
          </Link>
        </div>
        <div className="space-card-grid">
          {spaces.map((space) => (
            <article className={`space-card accent-${space.accent}`} key={space.id}>
              <div className="space-card-top">
                <span className="space-glyph" aria-hidden="true">
                  {space.name.slice(0, 1)}
                </span>
                <span className={space.currentEpisode === "In progress" ? "status-live" : "status-idle"}>{space.currentEpisode}</span>
              </div>
              <h3>{space.name}</h3>
              <p>{space.description}</p>
              <footer>
                <span>{space.lastActive}</span>
                <button type="button">
                  Open <Icon name="arrow" />
                </button>
              </footer>
            </article>
          ))}
        </div>
      </section>

      <div className="home-lower-grid">
        <section className="home-section recent-panel">
          <div className="section-title-row">
            <h2>Recent Episodes</h2>
            <Link to="/episodes">History</Link>
          </div>
          <div className="timeline-list">
            {recentEpisodes.map((episode, index) => (
              <article key={episode.title}>
                <span className={`timeline-dot dot-${index + 1}`} />
                <div>
                  <h3>{episode.title}</h3>
                  <p>{episode.space}</p>
                </div>
                <time>{episode.when}</time>
              </article>
            ))}
          </div>
        </section>
        <section className="home-section artifact-panel">
          <div className="section-title-row">
            <h2>Latest Artifacts</h2>
            <Link to="/artifacts">Browse</Link>
          </div>
          <div className="artifact-list">
            {recentArtifacts.map((artifact) => (
              <article key={artifact.title}>
                <span className="artifact-icon">
                  <Icon name="artifacts" />
                </span>
                <div>
                  <h3>{artifact.title}</h3>
                  <p>
                    {artifact.kind} · {artifact.when}
                  </p>
                </div>
                <Icon name="arrow" />
              </article>
            ))}
          </div>
          <div className="developer-nudge">
            <div>
              <span>&lt;/&gt;</span>
              <p>
                <strong>Building with Chalk?</strong> API keys and SDK setup live in Developer.
              </p>
            </div>
            <Link to="/developer">Open Developer</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
