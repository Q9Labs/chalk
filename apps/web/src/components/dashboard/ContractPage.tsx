import { Icon } from "./DashboardShell";

const pageCopy = {
  episodes: { eyebrow: "History", title: "Episodes", description: "A Tenant-wide view of the conversations that moved your work forward.", note: "Episode history needs the canonical Tenant read model before this surface can leave preview." },
  artifacts: { eyebrow: "Shared context", title: "Artifacts", description: "Notes, transcripts, and recordings created by your Episodes.", note: "Artifacts will appear here after processing state and authorization are canonical." },
  people: { eyebrow: "Tenant access", title: "People", description: "Invite people to your Tenant and understand where they collaborate.", note: "People is waiting on self-scoped Tenant access and invitation contracts." },
  developer: { eyebrow: "Build with Chalk", title: "Developer", description: "API keys, SDK setup, webhooks, and integration health—without taking over the product.", note: "Developer setup follows the core onboarding path and requires recent authentication for secrets." },
  activity: { eyebrow: "What changed", title: "Activity", description: "An audit-friendly timeline across your Tenant.", note: "Activity will use the canonical audit projection, with sensitive values removed." },
  tenant: { eyebrow: "Acme studio", title: "Tenant settings", description: "Manage Tenant identity, access, and product defaults.", note: "Settings require explicit Tenant capabilities and safe mutation contracts." },
  account: { eyebrow: "Your dashboard identity", title: "Account", description: "Manage your profile, authentication methods, and personal preferences.", note: "Dashboard Account stays separate from Users, Agents, Guests, Members, and Participants." },
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
          <Icon name={kind === "developer" ? "developer" : kind === "activity" ? "activity" : "artifacts"} />
        </span>
        <p className="eyebrow">Foundation first</p>
        <h2>This surface has a home.</h2>
        <p>{copy.note}</p>
        <div className="contract-rule">
          <strong>Preview contract</strong>
          <span>Navigation and language are stable. Data and mutations remain fixture-backed.</span>
        </div>
      </section>
    </div>
  );
}
