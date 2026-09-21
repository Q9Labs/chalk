import { Icon } from "./DashboardShell";

export function ArtifactsPage() {
  return (
    <div className="dashboard-page resource-page">
      <header className="dashboard-page-header resource-heading">
        <div>
          <p className="eyebrow">Episode history</p>
          <h1>Artifacts</h1>
          <p>Captures, transcripts, and video from your Episodes.</p>
        </div>
      </header>
      <section className="contract-state" aria-labelledby="artifacts-space-history-heading">
        <span>
          <Icon name="artifacts" />
        </span>
        <h2 id="artifacts-space-history-heading">Choose a Space</h2>
        <p>Open a Space to read its transcripts and request video for a captured Episode.</p>
        <a className="dashboard-button primary" href="/spaces">
          Open Spaces
        </a>
      </section>
    </div>
  );
}
