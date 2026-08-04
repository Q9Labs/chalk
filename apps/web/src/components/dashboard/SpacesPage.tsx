import { useState } from "react";
import { Icon } from "./DashboardShell";
import { NewSpaceDialog } from "./NewSpaceDialog";
import { spaces } from "./dashboard-data";

export function SpacesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <div className="dashboard-page resource-page">
      <header className="dashboard-page-header resource-heading">
        <div>
          <p className="eyebrow">Acme studio</p>
          <h1>Spaces</h1>
          <p>Durable places for recurring Episodes and shared context.</p>
        </div>
        <button className="dashboard-button primary" type="button" onClick={() => setCreateOpen(true)}>
          <Icon name="plus" />
          New Space
        </button>
      </header>
      <div className="resource-toolbar">
        <label className="resource-search">
          <span className="sr-only">Search Spaces</span>
          <input placeholder="Search Spaces" />
        </label>
        <span>{spaces.length} Spaces</span>
      </div>
      <div className="space-list">
        {spaces.map((space) => (
          <article key={space.id} className={`space-list-item accent-${space.accent}`}>
            <span className="space-glyph">{space.name.slice(0, 1)}</span>
            <div className="space-list-copy">
              <h2>{space.name}</h2>
              <p>{space.description}</p>
            </div>
            <div className="space-list-state">
              <span className={space.currentEpisode === "In progress" ? "status-live" : "status-idle"}>{space.currentEpisode}</span>
              <small>Current Episode</small>
            </div>
            <time>{space.lastActive}</time>
            <button type="button" aria-label={`Open ${space.name}`}>
              <Icon name="arrow" />
            </button>
          </article>
        ))}
      </div>
      <NewSpaceDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
