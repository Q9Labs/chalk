import { Button } from "@q9labsai/chalk-ui";
import { SAFE_ID_CLASSES, type DiagnosticFilterV1, type DiagnosticSnapshotV1, type SafeIdentifier } from "@q9labsai/diagnostics-contracts";
import { formatDuration, formatTime, type DebuggerSelection } from "./model";
import { StatusPill } from "./StatusPill";

export function DetailsPanel({
  snapshot,
  selection,
  onCopy,
  onSelect,
  onOpenRelated,
}: {
  snapshot: DiagnosticSnapshotV1;
  selection?: DebuggerSelection;
  onCopy: (text: string, label: string) => void;
  onSelect: (selection: DebuggerSelection) => void;
  onOpenRelated: (filter: DiagnosticFilterV1) => void;
}) {
  return (
    <aside className="episode-details-panel" aria-label="Diagnostic details">
      <IssuesSummary snapshot={snapshot} selection={selection} onSelect={onSelect} />
      <div className="episode-details-divider" />
      {!selection ? (
        <Overview snapshot={snapshot} />
      ) : selection.kind === "operation" ? (
        <OperationDetails operation={selection.value} onCopy={onCopy} onOpenRelated={onOpenRelated} />
      ) : selection.kind === "issue" ? (
        <IssueDetails issue={selection.value} onCopy={onCopy} onOpenRelated={onOpenRelated} />
      ) : selection.kind === "event" ? (
        <EventDetails event={selection.value} onCopy={onCopy} onOpenRelated={onOpenRelated} />
      ) : selection.kind === "branch" ? (
        <BranchDetails branch={selection.value} onCopy={onCopy} />
      ) : selection.kind === "participant" ? (
        <ParticipantDetails participant={selection.value} onOpenRelated={onOpenRelated} />
      ) : (
        <EdgeDetails snapshot={snapshot} edge={selection.value} onSelect={onSelect} />
      )}
    </aside>
  );
}

function IssuesSummary({ snapshot, selection, onSelect }: { snapshot: DiagnosticSnapshotV1; selection?: DebuggerSelection; onSelect: (selection: DebuggerSelection) => void }) {
  const open = snapshot.issues.filter((issue) => issue.state === "open");
  return (
    <section className="episode-details-issues" aria-labelledby="persistent-issues-title">
      <div className="episode-details-heading">
        <div>
          <p className="episode-caption">Persistent feed</p>
          <h2 id="persistent-issues-title">Issues</h2>
        </div>
        <span className="episode-issue-count">{open.length}</span>
      </div>
      {open.length === 0 ? (
        <p className="episode-muted">No open issues at cursor {snapshot.projectedCursor}.</p>
      ) : (
        <div className="episode-mini-issues">
          {open.slice(0, 10).map((issue) => (
            <button type="button" key={issue.id} data-selected={selection?.kind === "issue" && selection.value.id === issue.id} onClick={() => onSelect({ kind: "issue", value: issue })}>
              <StatusPill state={issue.severity} />
              <strong>{issue.summary}</strong>
              <span>{issue.missingCheckpoint ?? "missing boundary unknown"}</span>
            </button>
          ))}
          {open.length > 10 && <p className="episode-bounded-note">Showing 10 of {open.length} open issues. Open the Issues view for the full bounded projection.</p>}
        </div>
      )}
    </section>
  );
}

function Overview({ snapshot }: { snapshot: DiagnosticSnapshotV1 }) {
  return (
    <section>
      <div className="episode-details-heading">
        <div>
          <p className="episode-caption">Selection</p>
          <h2>Episode overview</h2>
        </div>
        <StatusPill state={snapshot.state} />
      </div>
      <FieldList
        fields={[
          ["Diagnostic reference", snapshot.reference],
          ["Environment", snapshot.environment],
          ["Captured", formatTime(snapshot.capturedAt)],
          ["Committed cursor", String(snapshot.committedCursor)],
          ["Projected cursor", String(snapshot.projectedCursor)],
          ["Run end cursor", snapshot.runEndCursor === undefined ? "unknown: Episode still live" : String(snapshot.runEndCursor)],
          ["Events", String(snapshot.summary.eventCount)],
          ["Operations", String(snapshot.summary.operationCount)],
          ["Issues", `${snapshot.summary.openIssueCount} open / ${snapshot.summary.issueCount} total`],
          ["Omissions", snapshot.omissions?.join(", ") || "none declared"],
        ]}
      />
    </section>
  );
}

function OperationDetails({ operation, onCopy, onOpenRelated }: { operation: Extract<DebuggerSelection, { kind: "operation" }>["value"]; onCopy: (text: string, label: string) => void; onOpenRelated: (filter: DiagnosticFilterV1) => void }) {
  const identifiers = [
    ["Request", "chalk.request", operation.requestId],
    ["Command", "chalk.command", operation.commandId],
    ["Provider", "provider", operation.providerId],
    ["Journey", "chalk.journey", operation.journeyId],
    ["Trace", "w3c.trace", operation.traceId],
    ["Span", "w3c.span", operation.spanId],
    ["Retry group", "chalk.retry", operation.retryGroup],
  ] as const;
  return (
    <section>
      <DetailsTitle caption="OperationDetail/v1" title={operation.kind} state={operation.state} />
      <FieldList
        fields={[
          ["Operation ID", operation.id],
          ["Schema", operation.schemaVersion ?? "OperationDetail/v1"],
          ["Parent operation", operation.parentId ?? "none declared"],
          ["Branch", operation.branchId ?? "none declared"],
          ["Diagnostic reference", operation.reference ?? operation.diagnosticReference ?? "unknown: not available"],
          ["State", operation.state],
          ["Start", formatTime(operation.startedAt)],
          ["End", formatTime(operation.endedAt)],
          ["Duration", formatDuration(operation.durationMilliseconds)],
          ["Expectation", `v${operation.expectationVersion}`],
          ["Attempt", String(operation.attempt)],
          ["Deadline", formatTime(operation.deadlineAt)],
          ["Grace ends", formatTime(operation.graceEndsAt)],
          ["Error class", operation.errorClass ?? "unknown: not available"],
          ["Source layer", operation.source],
          ["Release", operation.releaseId ?? "unknown: not available"],
          ["Source commit", operation.sourceCommit ?? "unknown: not available"],
          ["Clock uncertainty", operation.clockUncertainty ?? "unknown: not available"],
          ["Visibility gaps", operation.visibilityGaps?.join(", ") || "none declared"],
        ]}
      />
      <h3 className="episode-details-subtitle">Checkpoints</h3>
      <ol className="episode-checkpoints">
        {[...operation.checkpoints]
          .sort((left, right) => left.displayOrder - right.displayOrder)
          .map((checkpoint) => (
            <li key={checkpoint.key} data-tone={checkpoint.state}>
              <span className="episode-checkpoint-mark" aria-hidden="true" />
              <div>
                <strong>{checkpoint.key}</strong>
                <span>
                  {checkpoint.class} · {checkpoint.state}
                </span>
                <small>
                  deadline {formatTime(checkpoint.deadlineAt)} · evidence {checkpoint.evidenceCursor ?? `unknown: ${checkpoint.unknownReason ?? "not available"}`}
                </small>
              </div>
            </li>
          ))}
      </ol>
      <h3 className="episode-details-subtitle">Safe identifiers</h3>
      <div className="episode-identifiers">
        {identifiers.map(([label, idClass, identifier]) => (
          <Identifier key={label} label={label} idClass={idClass} identifier={identifier} onCopy={onCopy} />
        ))}
      </div>
      <div className="episode-details-actions">
        {(operation.reference ?? operation.diagnosticReference) && (
          <Button variant="outline" size="sm" onClick={() => onCopy((operation.reference ?? operation.diagnosticReference) as string, "Focused reference")}>
            Copy diagnostic reference
          </Button>
        )}
        {copyableIdentifierValue("w3c.trace", operation.traceId) && (
          <Button variant="outline" size="sm" onClick={() => onOpenRelated(parseRelatedTraceFilter(operation.traceId, operation.spanId))}>
            Open related trace
          </Button>
        )}
      </div>
    </section>
  );
}

function IssueDetails({ issue, onCopy, onOpenRelated }: { issue: Extract<DebuggerSelection, { kind: "issue" }>["value"]; onCopy: (text: string, label: string) => void; onOpenRelated: (filter: DiagnosticFilterV1) => void }) {
  const affected = (issue as typeof issue & { affected?: Readonly<{ kind: "participant" | "service"; identifier: SafeIdentifier }> }).affected;
  return (
    <section>
      <DetailsTitle caption="IssueDetail/v1" title={issue.summary} state={issue.severity} />
      <FieldList
        fields={[
          ["Issue state", issue.state],
          ["Kind", issue.kind],
          ["Affected Participant or service", affected ? `${affected.kind}: ${identifierDisplay(affected.identifier)}` : "unknown: not retained"],
          ["First observed", formatTime(issue.firstObservedAt)],
          ["Last observed", formatTime(issue.lastObservedAt)],
          ["Resolved", formatTime(issue.resolvedAt)],
          ["Last confirmed", issue.lastConfirmedCheckpoint ?? "unknown: not available"],
          ["First missing or failed", issue.missingCheckpoint ?? `unknown: ${issue.unknownReason ?? "not available"}`],
          ["Retry state", issue.retryState ?? "unknown: not available"],
          ["Operation ID", issue.operationId ?? "unknown: not available"],
        ]}
      />
      {affected && <Identifier label={`Affected ${affected.kind}`} idClass={affected.identifier.idClass} identifier={affected.identifier} onCopy={onCopy} />}
      {(issue.reference ?? issue.diagnosticReference) && (
        <Button variant="outline" size="sm" onClick={() => onCopy((issue.reference ?? issue.diagnosticReference) as string, "Issue reference")}>
          Copy issue reference
        </Button>
      )}
      {issue.operationId && (
        <Button variant="outline" size="sm" onClick={() => onOpenRelated({ schemaVersion: "DiagnosticFilter/v1" })}>
          Open related evidence
        </Button>
      )}
    </section>
  );
}

function EventDetails({ event, onCopy, onOpenRelated }: { event: Extract<DebuggerSelection, { kind: "event" }>["value"]; onCopy: (text: string, label: string) => void; onOpenRelated: (filter: DiagnosticFilterV1) => void }) {
  return (
    <section>
      <DetailsTitle caption={`Event cursor ${event.cursor}`} title={event.name} state={event.state} />
      <FieldList
        fields={[
          ["Phase", event.phase],
          ["Source", event.source],
          ["Occurred", formatTime(event.occurredAt)],
          ["Received", formatTime(event.receivedAt)],
          ["Producer sequence", String(event.producerSequence)],
          ["Diagnostic ID", event.diagnosticId],
          ["Producer operation", event.producerOperationRef ?? "unknown: not available"],
          ["Parent producer operation", event.parentProducerOperationRef ?? "unknown: not available"],
          ["Fingerprint", event.fingerprint],
          ["Expectation", event.expectation ? `${event.expectation.name}/v${event.expectation.version}` : "unknown: not available"],
          ["Checkpoint", event.expectation?.checkpoint ?? "unknown: not available"],
          ["Checkpoint class", event.expectation?.checkpointClass ?? "unknown: not available"],
          ["Deadline", formatTime(event.expectation?.deadlineAt)],
          ["Release", event.release?.id ?? "unknown: not available"],
          ["Source commit", event.release?.sourceCommit ?? "unknown: not available"],
          ["Safe attributes", Object.keys(event.attributes ?? {}).length ? JSON.stringify(event.attributes) : "none declared"],
        ]}
      />
      <h3 className="episode-details-subtitle">Correlation</h3>
      <div className="episode-identifiers">
        {Object.entries(event.correlation ?? {}).map(([label, value]) => (
          <Identifier key={label} label={label} idClass={correlationIdClass(label)} identifier={typeof value === "number" ? undefined : String(value)} onCopy={onCopy} />
        ))}
      </div>
      <Button variant="outline" size="sm" onClick={() => onCopy(event.eventId, "Event ID")}>
        Copy Event ID
      </Button>
      {event.correlation?.traceId && (
        <Button variant="outline" size="sm" onClick={() => onOpenRelated(parseRelatedTraceFilter(event.correlation?.traceId, event.correlation?.spanId))}>
          Open related trace
        </Button>
      )}
    </section>
  );
}

function BranchDetails({ branch, onCopy }: { branch: Extract<DebuggerSelection, { kind: "branch" }>["value"]; onCopy: (text: string, label: string) => void }) {
  return (
    <section>
      <DetailsTitle caption="BranchDetail/v1" title={branch.kind} state={branch.state} />
      <FieldList
        fields={[
          ["Lease ends", formatTime(branch.leaseEndsAt)],
          ["Started", formatTime(branch.startedAt)],
          ["Terminal", formatTime(branch.terminalAt)],
          ["Attempts", String(branch.attempts)],
          ["Terminal cursor", branch.terminalCursor === undefined ? "unknown: not available" : String(branch.terminalCursor)],
          ["Fan-in children", branch.fanInChildren?.join(", ") || "none declared"],
          ["Late observations", String(branch.lateObservations ?? 0)],
          ["Unknown reason", branch.unknownReason ?? "none declared"],
        ]}
      />
      {branch.reference && (
        <Button variant="outline" size="sm" onClick={() => onCopy(branch.reference as string, "Branch reference")}>
          Copy branch reference
        </Button>
      )}
    </section>
  );
}

function ParticipantDetails({ participant, onOpenRelated }: { participant: Extract<DebuggerSelection, { kind: "participant" }>["value"]; onOpenRelated: (filter: DiagnosticFilterV1) => void }) {
  return (
    <section>
      <DetailsTitle caption="ParticipantProjection/v1" title={participant.anonymousLabel} state={participant.state} />
      <FieldList
        fields={[
          ["Visibility", participant.visibility],
          ["Operations", String(participant.operationCount)],
          ["Issues", String(participant.issueCount)],
          ["Visibility gaps", participant.visibilityGaps.join(", ") || "none declared"],
        ]}
      />
      <Button variant="outline" size="sm" onClick={() => onOpenRelated({ schemaVersion: "DiagnosticFilter/v1", participantId: participant.participantId })}>
        Open Participant trace
      </Button>
    </section>
  );
}

function EdgeDetails({ snapshot, edge, onSelect }: { snapshot: DiagnosticSnapshotV1; edge: Extract<DebuggerSelection, { kind: "edge" }>["value"]; onSelect: (selection: DebuggerSelection) => void }) {
  return (
    <section>
      <DetailsTitle caption="Causal edge" title={edge.id} state={edge.state} />
      <FieldList
        fields={[
          ["State", edge.state],
          ["Operation evidence", edge.operationIds.join(", ") || "unknown: no operation evidence"],
          ["Issue evidence", edge.issueIds.join(", ") || "none declared"],
        ]}
      />
      <div className="episode-evidence-actions">
        {edge.operationIds.map((operationId) => {
          const operation = snapshot.operations.find((candidate) => candidate.id === operationId);
          return operation ? (
            <Button key={operationId} size="xs" variant="outline" onClick={() => onSelect({ kind: "operation", value: operation })}>
              Open {operation.kind}
            </Button>
          ) : (
            <span key={operationId} className="episode-muted">
              Operation {operationId} omitted from bounded snapshot
            </span>
          );
        })}
        {edge.issueIds.map((issueId) => {
          const issue = snapshot.issues.find((candidate) => candidate.id === issueId);
          return issue ? (
            <Button key={issueId} size="xs" variant="outline" onClick={() => onSelect({ kind: "issue", value: issue })}>
              Open issue
            </Button>
          ) : (
            <span key={issueId} className="episode-muted">
              Issue {issueId} omitted from bounded snapshot
            </span>
          );
        })}
      </div>
    </section>
  );
}

function DetailsTitle({ caption, title, state }: { caption: string; title: string; state: string }) {
  return (
    <div className="episode-details-heading">
      <div>
        <p className="episode-caption">{caption}</p>
        <h2>{title}</h2>
      </div>
      <StatusPill state={state} />
    </div>
  );
}

function FieldList({ fields }: { fields: readonly (readonly [string, string])[] }) {
  return (
    <dl className="episode-field-list">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={/reference|cursor|commit|fingerprint| ID$/.test(label) ? "episode-mono" : undefined} title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Identifier({ label, idClass, identifier, onCopy }: { label: string; idClass: string; identifier: SafeIdentifier | string | undefined; onCopy: (text: string, label: string) => void }) {
  const value = typeof identifier === "string" ? identifier : identifier?.value;
  const copyable = Boolean(value && copyableIdentifierValue(idClass, identifier));
  const reason = typeof identifier === "object" ? (identifier.unknownReason ?? "not_retained") : "not_available";
  const effectiveClass = typeof identifier === "object" ? identifier.idClass : idClass;
  const registered = SAFE_ID_CLASSES[effectiveClass as keyof typeof SAFE_ID_CLASSES];
  const display = registered?.storage === "raw" && value ? value : `unknown: ${registered?.storage === "hmac" ? "opaque identifier omitted" : reason.replaceAll("_", " ")}`;
  return (
    <div>
      <span>{label}</span>
      <code title={display}>{display}</code>
      <Button variant="ghost" size="xs" disabled={!value || !copyable} onClick={() => value && onCopy(value, `${label} ID`)}>
        Copy
      </Button>
    </div>
  );
}

function copyableIdentifierValue(idClass: string, identifier: SafeIdentifier | string | undefined): string | undefined {
  const effectiveClass = typeof identifier === "object" ? identifier.idClass : idClass;
  const rule = SAFE_ID_CLASSES[effectiveClass as keyof typeof SAFE_ID_CLASSES];
  if (!rule || !rule.copyable || rule.storage !== "raw") return undefined;
  if (typeof identifier === "object" && identifier.copyable !== true) return undefined;
  return typeof identifier === "string" ? identifier : identifier?.value;
}

function identifierDisplay(identifier: SafeIdentifier): string {
  const registered = SAFE_ID_CLASSES[identifier.idClass as keyof typeof SAFE_ID_CLASSES];
  return registered?.storage === "raw" && identifier.value ? identifier.value : `unknown: ${registered?.storage === "hmac" ? "opaque identifier omitted" : (identifier.unknownReason ?? "not_retained").replaceAll("_", " ")}`;
}

function correlationIdClass(key: string): string {
  return ({ journeyId: "chalk.journey", traceId: "w3c.trace", spanId: "w3c.span", requestId: "chalk.request", commandId: "chalk.command", providerId: "provider", retryGroupRef: "chalk.retry" } as Record<string, string>)[key] ?? "unknown";
}

function parseRelatedTraceFilter(traceIdentifier: SafeIdentifier | string | undefined, spanIdentifier: SafeIdentifier | string | undefined): DiagnosticFilterV1 {
  const traceId = copyableIdentifierValue("w3c.trace", traceIdentifier);
  const spanId = copyableIdentifierValue("w3c.span", spanIdentifier);
  return { schemaVersion: "DiagnosticFilter/v1", ...(traceId ? { traceId } : {}), ...(traceId && spanId ? { spanId } : {}) };
}
