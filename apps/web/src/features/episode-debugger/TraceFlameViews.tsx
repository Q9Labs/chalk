import { Button } from "@q9labsai/chalk-ui";
import type { AcceptedDiagnosticEvent, DiagnosticOperationDetail, DiagnosticSnapshotV1 } from "@q9labsai/diagnostics-contracts";
import { useMemo, useState } from "react";
import { DiagnosticTable } from "./DiagnosticTable";
import { safeReferenceLabel } from "./display-utils";
import { formatDuration, formatTime, selectedId, type DebuggerSelection } from "./model";
import { StatusPill } from "./StatusPill";
import { VirtualRows } from "./VirtualRows";
import { EvidenceEmpty } from "./RunGraphViews";
import type { DiagnosticPageState } from "./live-controller";

type TraceRow =
  | Readonly<{ key: string; kind: "operation"; value: DiagnosticOperationDetail; depth: number }>
  /* An Event reaches its producer either by declared ref or by a checkpoint's evidence
     cursor. The row builder already resolves both, so it carries the answer rather
     than leaving the row to re-derive it and call an attributed Event unattributed. */
  | Readonly<{ key: string; kind: "event"; value: AcceptedDiagnosticEvent; depth: number; attributed: boolean }>;

export function TraceView({
  snapshot,
  operations,
  events,
  eventPage,
  operationPage,
  selection,
  onSelect,
  onLoadMoreEvents,
  onLoadMoreOperations,
}: {
  snapshot: DiagnosticSnapshotV1;
  operations: readonly DiagnosticOperationDetail[];
  events: readonly AcceptedDiagnosticEvent[];
  eventPage: DiagnosticPageState;
  operationPage: DiagnosticPageState;
  selection?: DebuggerSelection;
  onSelect: (selection: DebuggerSelection) => void;
  onLoadMoreEvents: () => void;
  onLoadMoreOperations: () => void;
}) {
  const [tableMode, setTableMode] = useState(false);
  const rows = useMemo<TraceRow[]>(() => buildTraceRows(operations, events), [events, operations]);
  if (rows.length === 0) return <EvidenceEmpty title="No trace evidence" detail="Operations and bounded Event pages will appear here." />;
  const selectedKey = selection?.kind === "operation" ? `op-${selection.value.id}` : selection?.kind === "event" ? `event-${selection.value.cursor}` : undefined;

  return (
    <div className="episode-view-stack">
      <div className="episode-view-toolbar">
        <p>
          Showing {events.length} of {snapshot.summary.eventCount} Events · {operations.length} of {snapshot.summary.operationCount} operations
        </p>
        <div className="episode-toolbar-actions">
          <Button size="sm" variant="outline" disabled={!eventPage.hasMore || eventPage.loading || events.length >= eventPage.capacity} onClick={onLoadMoreEvents}>
            {eventPage.loading ? "Loading Events…" : "Load more Events"}
          </Button>
          <Button size="sm" variant="outline" disabled={!operationPage.hasMore || operationPage.loading || operations.length >= operationPage.capacity} onClick={onLoadMoreOperations}>
            {operationPage.loading ? "Loading operations…" : "Load more operations"}
          </Button>
          <Button size="sm" variant="outline" aria-pressed={tableMode} onClick={() => setTableMode((value) => !value)}>
            {tableMode ? "Show hierarchy" : "Table alternative"}
          </Button>
        </div>
      </div>
      {(eventPage.error || operationPage.error) && (
        <p className="episode-page-error" role="alert">
          {eventPage.error ?? operationPage.error}
        </p>
      )}
      <div className="episode-trace-header" role="row" aria-label="Trace columns">
        <span role="columnheader">Time / operation</span>
        <span role="columnheader">Source</span>
        <span role="columnheader">Duration</span>
        <span role="columnheader">State</span>
      </div>
      {tableMode ? (
        <TraceTable rows={rows} onSelect={onSelect} />
      ) : (
        <VirtualRows
          items={rows}
          getKey={(row) => row.key}
          label="Diagnostic operation and Event hierarchy"
          selectedKey={selectedKey}
          onSelect={(row) => onSelect({ kind: row.kind, value: row.value } as DebuggerSelection)}
          renderRow={(row) => (
            <div className="episode-trace-tree-row" data-depth={Math.min(row.depth, 4)}>
              {row.kind === "operation" ? <OperationRow operation={row.value} /> : <EventRow event={row.value} attributed={row.attributed} />}
            </div>
          )}
        />
      )}
      <p className="episode-bounded-note">
        This client holds at most {eventPage.capacity} Events and {operationPage.capacity} operations. {eventPage.hasMore || operationPage.hasMore ? "More server pages remain; load them or narrow the cursor/time window." : "The current server pages are exhausted."}{" "}
        {snapshot.omissions?.length ? `Server omissions: ${snapshot.omissions.join(", ")}.` : "No additional server omissions declared."}
      </p>
    </div>
  );
}

function buildTraceRows(operations: readonly DiagnosticOperationDetail[], events: readonly AcceptedDiagnosticEvent[]): TraceRow[] {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const byEvidenceCursor = new Map<number, DiagnosticOperationDetail>();
  for (const operation of operations) {
    for (const checkpoint of operation.checkpoints) {
      if (checkpoint.evidenceCursor !== undefined) byEvidenceCursor.set(checkpoint.evidenceCursor, operation);
    }
  }
  const depthFor = (operation: DiagnosticOperationDetail): number => {
    let depth = 0;
    let parentId = operation.parentId;
    const seen = new Set<string>();
    while (parentId && byId.has(parentId) && !seen.has(parentId) && depth < 12) {
      seen.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    return depth;
  };
  const operationRows: TraceRow[] = operations.map((value) => ({ key: `op-${value.id}`, kind: "operation", value, depth: depthFor(value) }));
  const eventRows: TraceRow[] = events.map((value) => {
    const producer = (value.producerOperationRef ? byId.get(value.producerOperationRef) : undefined) ?? byEvidenceCursor.get(value.cursor);
    return { key: `event-${value.cursor}`, kind: "event", value, depth: producer ? depthFor(producer) + 1 : 0, attributed: producer !== undefined };
  });
  return [...operationRows, ...eventRows].sort((left, right) => rowTime(left) - rowTime(right));
}

function TraceTable({ rows, onSelect }: { rows: readonly TraceRow[]; onSelect: (selection: DebuggerSelection) => void }) {
  return (
    <DiagnosticTable caption="Diagnostic operation and Event table alternative" headers={["Type", "Evidence", "Source", "State"]}>
      {rows.map((row) => (
        <tr key={row.key}>
          <td>{row.kind}</td>
          <td>
            <Button size="xs" variant="ghost" onClick={() => onSelect({ kind: row.kind, value: row.value } as DebuggerSelection)}>
              {row.kind === "operation" ? row.value.kind : row.value.name}
            </Button>
          </td>
          <td>{row.value.source}</td>
          <td>
            <StatusPill state={row.value.state} />
          </td>
        </tr>
      ))}
    </DiagnosticTable>
  );
}

export function FlameView({ snapshot, selection, onSelect }: { snapshot: DiagnosticSnapshotV1; selection?: DebuggerSelection; onSelect: (selection: DebuggerSelection) => void }) {
  const [zoom, setZoom] = useState(1);
  const [tableMode, setTableMode] = useState(false);
  const flame = snapshot.flame;
  if (!flame) return <EvidenceEmpty title="Flame projection unavailable" detail="The server did not include a bounded FlameProjection/v1." />;
  const times = flame.lanes.flatMap((lane) => lane.bars.flatMap((bar) => [Date.parse(bar.startAt), bar.endAt ? Date.parse(bar.endAt) : Date.parse(bar.startAt) + 1_000])).filter(Number.isFinite);
  const start = Math.min(...times);
  const end = Math.max(...times);
  const range = Math.max(1, end - start);

  return (
    <div className="episode-view-stack">
      <div className="episode-view-toolbar">
        <p>{flame.lanes.length} bounded lanes · periodic samples aggregated</p>
        <div className="episode-toolbar-actions">
          <Button size="sm" variant="outline" onClick={() => setZoom((value) => Math.max(1, value / 1.5))} aria-label="Zoom out">
            −
          </Button>
          <span className="episode-mono" aria-live="polite">
            {zoom.toFixed(1)}×
          </span>
          <Button size="sm" variant="outline" onClick={() => setZoom((value) => Math.min(12, value * 1.5))} aria-label="Zoom in">
            +
          </Button>
          <Button size="sm" variant="outline" aria-pressed={tableMode} onClick={() => setTableMode((value) => !value)}>
            {tableMode ? "Show waterfall" : "Table alternative"}
          </Button>
        </div>
      </div>
      {tableMode ? (
        <FlameTable snapshot={snapshot} onSelect={onSelect} />
      ) : (
        <div className="episode-flame-scroll">
          <div className="episode-flame" style={{ inlineSize: `${zoom * 100}%` }} aria-label="Operation waterfall">
            <div className="episode-flame-ruler" aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => (
                <span key={index} style={{ insetInlineStart: `${index * 20}%` }}>
                  {formatDuration((range * index) / 5)}
                </span>
              ))}
            </div>
            {flame.lanes.map((lane) => (
              <div className="episode-flame-lane" key={lane.id}>
                <div className="episode-flame-label">
                  <strong>{lane.label}</strong>
                  <span>{lane.source}</span>
                </div>
                <div className="episode-flame-track">
                  {lane.bars.map((bar) => {
                    const operation = bar.operationId ? snapshot.operations.find((candidate) => candidate.id === bar.operationId) : undefined;
                    const left = Math.max(0, Math.min(100 - FLAME_MIN_BAR_PERCENT, ((Date.parse(bar.startAt) - start) / range) * 100));
                    const duration = (bar.endAt ? Date.parse(bar.endAt) : end) - Date.parse(bar.startAt);
                    const width = Math.min(100 - left, Math.max(FLAME_MIN_BAR_PERCENT, (duration / range) * 100));
                    const label = operation?.kind ?? `attempt ${bar.attempt ?? 1}`;
                    const description = `${label}, ${bar.state.replaceAll("_", " ")}, ${formatDuration(duration)}`;
                    return (
                      <button
                        type="button"
                        key={bar.id}
                        className="episode-flame-bar"
                        data-tone={bar.state}
                        data-selected={operation?.id === selectedId(selection)}
                        style={{ insetInlineStart: `${left}%`, inlineSize: `${width}%` }}
                        onClick={() => operation && onSelect({ kind: "operation", value: operation })}
                        title={description}
                        aria-label={description}
                      >
                        {/* A bar too narrow for its label renders a clipped fragment that
                            reads as noise; the tooltip still carries the full name. */}
                        {fitsLabel(width, zoom, label) && <span>{label}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="episode-heat-legend">
              <span>Sample density</span>
              <div className="episode-heat-strip" aria-label={`${flame.buckets.length} aggregated sample buckets`}>
                {flame.buckets.map((bucket, index) => (
                  <span key={`${bucket.startAt}-${index}`} style={{ opacity: Math.max(0.12, bucket.heat) }} data-failed={bucket.failedCount > 0} title={`${bucket.count} samples, ${bucket.failedCount} failed`} />
                ))}
              </div>
              <span>Tinted buckets carry failures</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* The track has no measured width at render time, so estimate from the lane's
   declared minimum times the current zoom. Erring narrow drops a label; erring
   wide would clip one. */
/* An instant-length bar at the very end of the range still has to read as a bar,
   so it keeps this much of the track rather than collapsing against the edge. */
const FLAME_MIN_BAR_PERCENT = 1.2;

const FLAME_TRACK_BASELINE_PIXELS = 660;
const FLAME_LABEL_PIXELS_PER_CHARACTER = 5.8;

function fitsLabel(widthPercent: number, zoom: number, label: string): boolean {
  return (widthPercent / 100) * FLAME_TRACK_BASELINE_PIXELS * zoom >= label.length * FLAME_LABEL_PIXELS_PER_CHARACTER + 18;
}

/* The subtitle carries what separates this row from its neighbours, not the fields
   every row shares. Defaults (first attempt, expectation v1, no parent) are silent;
   the details panel still states them for whichever row is selected. */
function operationSubtitle(operation: DiagnosticOperationDetail): string {
  const observed = operation.checkpoints.filter((checkpoint) => checkpoint.state === "observed" || checkpoint.state === "late_observed").length;
  const parts = [operation.checkpoints.length === 0 ? "no checkpoints declared" : `${observed}/${operation.checkpoints.length} checkpoints observed`];
  if (operation.attempt > 1) parts.push(`attempt ${operation.attempt}`);
  if (operation.expectationVersion > 1) parts.push(`expectation v${operation.expectationVersion}`);
  if (operation.retryGroup) parts.push(`retry ${safeReferenceLabel(operation.retryGroup)}`);
  if (operation.errorClass) parts.push(operation.errorClass);
  return parts.join(" · ");
}

function OperationRow({ operation }: { operation: DiagnosticOperationDetail }) {
  return (
    <>
      <div className="episode-trace-primary" role="gridcell">
        <span className="episode-mono">{formatTime(operation.startedAt)}</span>
        <strong>{operation.kind}</strong>
        <small>{operationSubtitle(operation)}</small>
      </div>
      <span role="gridcell" className="episode-trace-source">
        {operation.source}
      </span>
      <span role="gridcell" className="episode-trace-duration">
        <span className="episode-mono">{formatDuration(operation.durationMilliseconds)}</span>
        {/* Only the rows that carry a measured uncertainty say so; the details
            panel states the unknown case once instead of on every row. */}
        {operation.clockUncertainty ? <small>clock {operation.clockUncertainty}</small> : null}
      </span>
      <span role="gridcell">
        <StatusPill state={operation.state} />
      </span>
    </>
  );
}

/* Rows are nested under their producer, so naming it again on every line says
   nothing; the anomaly — an Event no operation claims — is what gets called out.
   Receipt time only appears when it trails the Event, which is the lag worth seeing. */
function eventSubtitle(event: AcceptedDiagnosticEvent, attributed: boolean): string {
  const parts = [`cursor ${event.cursor}`, event.phase];
  if (!attributed) parts.push("no producing operation");
  const lag = Date.parse(event.receivedAt) - Date.parse(event.occurredAt);
  if (Number.isFinite(lag) && lag > 0) parts.push(`received +${formatDuration(lag)}`);
  return parts.join(" · ");
}

function EventRow({ event, attributed }: { event: AcceptedDiagnosticEvent; attributed: boolean }) {
  return (
    <>
      <div className="episode-trace-primary" role="gridcell">
        <span className="episode-mono">{formatTime(event.occurredAt)}</span>
        <strong>{event.name}</strong>
        <small>{eventSubtitle(event, attributed)}</small>
      </div>
      <span role="gridcell" className="episode-trace-source">
        {event.source}
      </span>
      <span role="gridcell" className="episode-trace-duration">
        <span className="episode-mono">seq {event.producerSequence}</span>
      </span>
      <span role="gridcell">
        <StatusPill state={event.state} />
      </span>
    </>
  );
}

function FlameTable({ snapshot, onSelect }: { snapshot: DiagnosticSnapshotV1; onSelect: (selection: DebuggerSelection) => void }) {
  const flame = snapshot.flame;
  if (!flame) return null;
  return (
    <DiagnosticTable caption="Operation waterfall table alternative" headers={["Lane", "Operation", "Start", "End", "State"]}>
      {flame.lanes.flatMap((lane) =>
        lane.bars.map((bar) => {
          const operation = bar.operationId ? snapshot.operations.find((candidate) => candidate.id === bar.operationId) : undefined;
          return (
            <tr key={bar.id}>
              <td>{lane.label}</td>
              <td>
                {operation ? (
                  <Button variant="ghost" size="xs" onClick={() => onSelect({ kind: "operation", value: operation })}>
                    {operation.kind}
                  </Button>
                ) : (
                  bar.id
                )}
              </td>
              <td className="episode-mono">{formatTime(bar.startAt)}</td>
              <td className="episode-mono">{formatTime(bar.endAt)}</td>
              <td>
                <StatusPill state={bar.state} />
              </td>
            </tr>
          );
        }),
      )}
    </DiagnosticTable>
  );
}

const rowTime = (row: TraceRow): number => Date.parse(row.kind === "operation" ? row.value.startedAt : row.value.receivedAt);
