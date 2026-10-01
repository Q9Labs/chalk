import { useDashboardAccount } from "./DashboardAccount";
import { SpaceRecordingHistorySection } from "./SpaceRecordingHistorySection";

export function ArtifactsPage() {
  const { current } = useDashboardAccount();
  return (
    <div className="dashboard-page resource-page">
      <header className="dashboard-page-header resource-heading">
        <div>
          <p className="eyebrow">{current.tenant.name}</p>
          <h1>Recordings</h1>
          <p>Captures, transcripts, and video from every Space in this Tenant.</p>
        </div>
      </header>
      <SpaceRecordingHistorySection tenantID={current.tenant.id} />
    </div>
  );
}
