import { Icon } from "./DashboardShell";

const pageCopy = {
  people: {
    eyebrow: "Tenant access",
    title: "People",
    description: "Invite people to your Tenant and see where they collaborate.",
    heading: "No one else has been invited yet",
    note: "Invitations are coming soon. Until then, anyone who joins a Space from its link appears in that Space's Episodes.",
    icon: "artifacts",
  },
  activity: { eyebrow: "What changed", title: "Activity", description: "A timeline of changes across your Tenant.", heading: "Nothing to show yet", note: "Changes to Spaces, API keys, and Tenant settings will appear here.", icon: "activity" },
} as const;

export function ContractPage({ kind }: { kind: keyof typeof pageCopy }) {
  const copy = pageCopy[kind];
  return (
    <div className="dashboard-page resource-page">
      <header className="dashboard-page-header resource-heading">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
      </header>
      <section className="contract-state">
        <span>
          <Icon name={copy.icon} />
        </span>
        <h2>{copy.heading}</h2>
        <p>{copy.note}</p>
      </section>
    </div>
  );
}
