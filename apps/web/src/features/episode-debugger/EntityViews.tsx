import { Button, Card, CardContent, CardHeader, CardTitle } from "@q9labsai/chalk-ui";
import type { DiagnosticFilterV1, DiagnosticSnapshotV1 } from "@q9labsai/diagnostics-contracts";
import { formatTime, type DebuggerSelection } from "./model";
import { participantIdentityDisplay, safeIdentifierDisplay } from "./display-utils";
import { EvidenceEmpty } from "./RunGraphViews";
import { StatusPill } from "./StatusPill";

/* A card states the facts this issue actually carries. A projection that declares
   nothing for a field used to print "unknown: not available" anyway, so four cards
   read as a wall of absences with the real finding buried in it; the details panel
   still enumerates every field, present or not, for whichever issue is selected.
   A declared unknownReason is itself evidence and stays. */
function issueFacts(issue: DiagnosticSnapshotV1["issues"][number]): readonly (readonly [string, string])[] {
  const facts: (readonly [string, string])[] = [["First observed", formatTime(issue.firstObservedAt)]];
  if (issue.lastConfirmedCheckpoint) facts.push(["Last confirmed", issue.lastConfirmedCheckpoint]);
  if (issue.missingCheckpoint) facts.push(["First missing", issue.missingCheckpoint]);
  else if (issue.unknownReason) facts.push(["First missing", `unknown: ${issue.unknownReason}`]);
  if (issue.retryState) facts.push(["Retry", issue.retryState]);
  if (issue.affected) facts.push(["Affected", `${issue.affected.kind}: ${safeIdentifierDisplay(issue.affected.identifier)}`]);
  return facts;
}

export function IssuesView({ snapshot, onSelect }: { snapshot: DiagnosticSnapshotV1; onSelect: (selection: DebuggerSelection) => void }) {
  if (snapshot.issues.length === 0) return <EvidenceEmpty title="No diagnostic issues" detail="No explicit failure, missed confirmation, deadline overrun, recovery exhaustion, unexpected transition, or telemetry gap is visible at this cursor." />;
  return (
    <div className="episode-card-list">
      {snapshot.issues.map((issue) => {
        const reference = issue.reference ?? issue.diagnosticReference;
        return (
          <Card key={issue.id} size="sm" className="episode-issue-card" data-severity={issue.severity}>
            <CardHeader>
              <p className="episode-eyebrow">{issue.kind.replaceAll("_", " ")}</p>
              <div className="episode-card-title-row">
                <StatusPill state={issue.severity} />
                <CardTitle>{issue.summary}</CardTitle>
                <StatusPill state={issue.state} />
              </div>
            </CardHeader>
            <CardContent>
              <dl className="episode-inline-facts">
                {issueFacts(issue).map(([term, value]) => (
                  <div key={term}>
                    <dt>{term}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="episode-issue-footer">
                {reference ? (
                  <p>
                    <span>Diagnostic reference</span>
                    <code className="episode-mono">{reference}</code>
                  </p>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => onSelect({ kind: "issue", value: issue })}>
                  Inspect issue
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/* A Participant who has not left has no departure time to be missing; printing
   "unknown" there reads as lost evidence rather than as presence. Presence is only
   claimed for a state that asserts it — a lane whose state is itself unknown says so. */
function departureDisplay(participant: NonNullable<DiagnosticSnapshotV1["participants"]>[number]): string {
  if (participant.leftAt) return formatTime(participant.leftAt);
  if (participant.state === "joined" || participant.state === "reconnecting") return "still in Episode";
  return "unknown: not available";
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
                <dd>{departureDisplay(participant)}</dd>
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
