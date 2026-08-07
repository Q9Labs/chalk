import { Button, Card, CardContent, CardHeader, CardTitle } from "@q9labsai/chalk-ui";
import type { DiagnosticFilterV1, DiagnosticSnapshotV1 } from "@chalk/diagnostics-contracts";
import { formatTime, type DebuggerSelection } from "./model";
import { participantIdentityDisplay, safeIdentifierDisplay } from "./display-utils";
import { EvidenceEmpty } from "./RunGraphViews";
import { StatusPill } from "./StatusPill";

export function IssuesView({ snapshot, onSelect }: { snapshot: DiagnosticSnapshotV1; onSelect: (selection: DebuggerSelection) => void }) {
  if (snapshot.issues.length === 0) return <EvidenceEmpty title="No diagnostic issues" detail="No explicit failure, missed confirmation, deadline overrun, recovery exhaustion, unexpected transition, or telemetry gap is visible at this cursor." />;
  return (
    <div className="episode-card-list">
      {snapshot.issues.map((issue) => (
        <Card key={issue.id} size="sm" className="episode-issue-card" data-severity={issue.severity}>
          <CardHeader>
            <div className="episode-card-title-row">
              <StatusPill state={issue.severity} />
              <StatusPill state={issue.state} />
            </div>
            <CardTitle>{issue.summary}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="episode-inline-facts">
              <div>
                <dt>First observed</dt>
                <dd>{formatTime(issue.firstObservedAt)}</dd>
              </div>
              <div>
                <dt>Last confirmed</dt>
                <dd>{issue.lastConfirmedCheckpoint ?? "unknown: not available"}</dd>
              </div>
              <div>
                <dt>First missing</dt>
                <dd>{issue.missingCheckpoint ?? `unknown: ${issue.unknownReason ?? "not available"}`}</dd>
              </div>
              <div>
                <dt>Retry</dt>
                <dd>{issue.retryState ?? "unknown: not available"}</dd>
              </div>
              <div>
                <dt>Affected</dt>
                <dd>{issue.affected ? `${issue.affected.kind}: ${safeIdentifierDisplay(issue.affected.identifier)}` : "unknown: not retained"}</dd>
              </div>
              <div className="episode-fact-wide">
                <dt>Diagnostic reference</dt>
                <dd className="episode-mono">{issue.reference ?? issue.diagnosticReference ?? "unknown: not available"}</dd>
              </div>
            </dl>
            <Button size="sm" variant="outline" onClick={() => onSelect({ kind: "issue", value: issue })}>
              Inspect issue
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function ParticipantsView({ snapshot, onSelect, onOpenRelated }: { snapshot: DiagnosticSnapshotV1; onSelect: (selection: DebuggerSelection) => void; onOpenRelated: (filter: DiagnosticFilterV1) => void }) {
  const participants = snapshot.participants ?? [];
  if (participants.length === 0) return <EvidenceEmpty title="No Participant projections" detail="ParticipantProjection/v1 rows appear without names or raw identities." />;
  return (
    <div className="episode-participant-grid">
      {participants.map((participant, index) => (
        <Card key={participant.participantId} size="sm">
          <CardHeader>
            <div className="episode-participant-heading">
              <span className="episode-participant-avatar">P{index + 1}</span>
              <div>
                <CardTitle>{participant.display.label.value ?? participant.anonymousLabel}</CardTitle>
                <p>
                  {participant.identityKind} · {participant.visibility.replaceAll("_", " ")}
                </p>
              </div>
              <StatusPill state={participant.state} />
            </div>
          </CardHeader>
          <CardContent>
            <dl className="episode-inline-facts">
              <div>
                <dt>Joined</dt>
                <dd>{formatTime(participant.joinedAt)}</dd>
              </div>
              <div>
                <dt>Left</dt>
                <dd>{formatTime(participant.leftAt)}</dd>
              </div>
              <div>
                <dt>Operations</dt>
                <dd>{participant.operationCount}</dd>
              </div>
              <div>
                <dt>Issues</dt>
                <dd>{participant.issueCount}</dd>
              </div>
              <div className="episode-fact-wide">
                <dt>Identity</dt>
                <dd>{participantIdentityDisplay(participant.display.rawIdentity)}</dd>
              </div>
            </dl>
            {participant.visibilityGaps.length > 0 && (
              <div className="episode-gap-list">
                <strong>Visibility gaps</strong>
                {participant.visibilityGaps.map((gap) => (
                  <span key={gap}>{gap}</span>
                ))}
              </div>
            )}
            <div className="episode-details-actions">
              <Button size="sm" variant="outline" onClick={() => onSelect({ kind: "participant", value: participant })}>
                Inspect Participant
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onOpenRelated({ schemaVersion: "DiagnosticFilter/v1", participantId: participant.participantId })}>
                Open trace
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function EpilogueView({ snapshot, onSelect }: { snapshot: DiagnosticSnapshotV1; onSelect: (selection: DebuggerSelection) => void }) {
  const epilogue = snapshot.epilogue;
  const branches = epilogue?.branches ?? snapshot.branches;
  if (branches.length === 0) return <EvidenceEmpty title="No Epilogue branches" detail="This Episode has no authorized cleanup, recording, transcription, artifact, or webhook work." />;
  return (
    <div className="episode-view-stack">
      <div className="episode-epilogue-summary">
        <div>
          <p className="episode-eyebrow">Post-Episode work</p>
          <h2>Epilogue</h2>
        </div>
        <StatusPill state={epilogue?.state ?? "pending"} />
        <p>
          {epilogue?.openBranchCount ?? branches.filter((branch) => branch.state === "pending" || branch.state === "running").length} open · {epilogue?.terminalBranchCount ?? branches.filter((branch) => !["pending", "running"].includes(branch.state)).length} terminal
        </p>
      </div>
      <div className="episode-branch-flow">
        {branches.map((branch, index) => (
          <button type="button" key={branch.id} className="episode-branch" data-tone={branch.state} onClick={() => onSelect({ kind: "branch", value: branch })}>
            <span className="episode-branch-index">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{branch.kind}</strong>
              <span>
                attempts {branch.attempts} · lease {formatTime(branch.leaseEndsAt)}
              </span>
            </div>
            <StatusPill state={branch.state} />
            {branch.lateObservations ? <span className="episode-late">{branch.lateObservations} late</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
