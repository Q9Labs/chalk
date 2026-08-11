import { Button, Card, CardContent, CardHeader, CardTitle } from "@q9labsai/chalk-ui";
import type { DiagnosticSnapshotV1 } from "@q9labsai/diagnostics-contracts";
import { useState } from "react";
import { DiagnosticTable } from "./DiagnosticTable";
import { formatDuration } from "./model";
import type { DebuggerSelection } from "./model";
import { StatusPill } from "./StatusPill";

export function RunView({ snapshot, onSelect }: { snapshot: DiagnosticSnapshotV1; onSelect: (selection: DebuggerSelection) => void }) {
  const run = snapshot.run;
  if (!run) return <EvidenceEmpty title="Run projection unavailable" detail="The server did not include a bounded RunProjection/v1 at this cursor." />;
  const releaseMix = snapshot.operations.reduce<Map<string, number>>((counts, operation) => {
    const release = operation.releaseId ?? "unknown: not available";
    counts.set(release, (counts.get(release) ?? 0) + 1);
    return counts;
  }, new Map());

  return (
    <div className="episode-view-stack">
      <div className="episode-metric-grid">
        <Metric label="Elapsed" value={formatDuration(run.elapsedMilliseconds)} />
        <Metric label="Participants" value={String(run.participantCount)} />
        <Metric label="Active operations" value={String(run.activeOperationCount)} />
        <Metric label="Open issues" value={String(run.openIssueCount)} tone={run.openIssueCount > 0 ? "danger" : "success"} />
      </div>
      <div className="episode-release-mix">
        <span>Observed release mix · bounded snapshot</span>
        <div>
          {releaseMix.size === 0 ? (
            <code>unknown: no projected operations</code>
          ) : (
            [...releaseMix].map(([release, count]) => (
              <code key={release}>
                {release} · {count}
              </code>
            ))
          )}
        </div>
      </div>
      <div className="episode-boundary-grid">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Latest confirmed boundary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="episode-evidence-value">{run.latestConfirmedBoundary?.value ?? `unknown: ${run.latestConfirmedBoundary?.unknownReason ?? "not available"}`}</p>
          </CardContent>
        </Card>
        <Card size="sm" className="episode-card-warning">
          <CardHeader>
            <CardTitle>First broken boundary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="episode-evidence-value">{run.firstMissingBoundary?.value ?? `unknown: ${run.firstMissingBoundary?.unknownReason ?? "not available"}`}</p>
          </CardContent>
        </Card>
      </div>
      <section aria-labelledby="participant-lanes-title">
        <div className="episode-section-heading">
          <div>
            <p className="episode-caption">Receive order</p>
            <h2 id="participant-lanes-title">Participant lanes</h2>
          </div>
          <span className="episode-mono">cursor {snapshot.projectedCursor}</span>
        </div>
        <div className="episode-lanes">
          {run.participantLanes.length === 0 ? (
            <EvidenceEmpty title="No Participant activity" detail="Lanes appear as bounded projections arrive." />
          ) : (
            run.participantLanes.map((lane, index) => (
              <div className="episode-lane" key={lane.participantId}>
                <div className="episode-lane-label">
                  <span className="episode-participant-mark">P{index + 1}</span>
                  <span className="episode-mono episode-truncate">{lane.participantId}</span>
                  <StatusPill state={lane.state} />
                </div>
                <div className="episode-lane-track">
                  {lane.operationIds.map((operationId, operationIndex) => {
                    const operation = snapshot.operations.find((candidate) => candidate.id === operationId);
                    return (
                      <button
                        key={operationId}
                        type="button"
                        className="episode-run-block"
                        data-tone={operation ? operation.state : "neutral"}
                        style={{ inlineSize: `${Math.max(44, 76 - operationIndex)}px` }}
                        onClick={() => operation && onSelect({ kind: "operation", value: operation })}
                        aria-label={operation ? `${operation.kind}, ${operation.state}` : `Unknown operation ${operationId}`}
                      >
                        <span>{operation?.kind.split(".").at(-1) ?? "unknown"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
      <p className="episode-bounded-note">
        RunProjection/v1 contains {run.participantLanes.length} bounded Participant lanes. The snapshot exposes {snapshot.operations.length} of {snapshot.summary.operationCount} operations; broader operation evidence is available in the paged Trace view.
      </p>
      <div className="episode-unsupported">
        <span aria-hidden="true">◇</span>
        <div>
          <strong>Whiteboard diagnostics are unsupported in v1</strong>
          <p>No whiteboard content or checkpoints are presented as complete.</p>
        </div>
      </div>
    </div>
  );
}

export function GraphView({ snapshot, onSelect }: { snapshot: DiagnosticSnapshotV1; onSelect: (selection: DebuggerSelection) => void }) {
  const [tableMode, setTableMode] = useState(false);
  const [page, setPage] = useState(0);
  const graph = snapshot.graph;
  if (!graph) return <EvidenceEmpty title="Graph projection unavailable" detail="The server did not include GraphProjection/v1." />;
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(graph.nodes.length / pageSize));
  const boundedPage = Math.min(page, pageCount - 1);
  const visibleNodes = graph.nodes.slice(boundedPage * pageSize, (boundedPage + 1) * pageSize);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = graph.edges.filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to));

  return (
    <div className="episode-view-stack">
      <div className="episode-view-toolbar">
        <p>
          {graph.summary.nodeCount} systems · {graph.summary.edgeCount} causal edges · projection carries {graph.nodes.length} nodes / {graph.edges.length} edges
        </p>
        <div className="episode-toolbar-actions">
          {!tableMode && (
            <Button size="sm" variant="outline" disabled={boundedPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
              Previous nodes
            </Button>
          )}
          {!tableMode && (
            <span className="episode-mono">
              {boundedPage + 1}/{pageCount}
            </span>
          )}
          {!tableMode && (
            <Button size="sm" variant="outline" disabled={boundedPage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>
              Next nodes
            </Button>
          )}
          <Button size="sm" variant="outline" aria-pressed={tableMode} onClick={() => setTableMode((value) => !value)}>
            {tableMode ? "Show graph" : "Table alternative"}
          </Button>
        </div>
      </div>
      {tableMode ? (
        <DiagnosticTable caption="Causal diagnostic graph edges" headers={["From", "To", "State", "Evidence"]}>
          {graph.edges.map((edge) => (
            <tr key={edge.id}>
              <td>{graph.nodes.find((node) => node.id === edge.from)?.label ?? edge.from}</td>
              <td>{graph.nodes.find((node) => node.id === edge.to)?.label ?? edge.to}</td>
              <td>
                <StatusPill state={edge.state} />
              </td>
              <td>
                <Button size="xs" variant="ghost" onClick={() => onSelect({ kind: "edge", value: edge })}>
                  {edge.operationIds.length} operations
                </Button>
              </td>
            </tr>
          ))}
        </DiagnosticTable>
      ) : (
        <div className="episode-graph" aria-label={`Causal system graph, node page ${boundedPage + 1} of ${pageCount}`}>
          <svg className="episode-graph-lines" aria-hidden="true" viewBox="0 0 900 480" preserveAspectRatio="none">
            {visibleEdges.map((edge, index) => {
              const fromIndex = Math.max(
                0,
                visibleNodes.findIndex((node) => node.id === edge.from),
              );
              const toIndex = Math.max(
                0,
                visibleNodes.findIndex((node) => node.id === edge.to),
              );
              const x1 = 90 + (fromIndex % 4) * 235;
              const y1 = 70 + Math.floor(fromIndex / 4) * 150;
              const x2 = 90 + (toIndex % 4) * 235;
              const y2 = 70 + Math.floor(toIndex / 4) * 150;
              return <line key={`${edge.id}-${index}`} x1={x1} y1={y1} x2={x2} y2={y2} data-tone={edge.state} />;
            })}
          </svg>
          {visibleNodes.map((node, index) => (
            <button
              type="button"
              key={node.id}
              className="episode-graph-node"
              data-tone={node.state}
              style={{ insetInlineStart: `calc(${index % 4} * 25% + 1%)`, insetBlockStart: `${Math.floor(index / 4) * 150 + 34}px` }}
              onClick={() => {
                const edge = graph.edges.find((candidate) => candidate.from === node.id || candidate.to === node.id);
                if (edge) onSelect({ kind: "edge", value: edge });
              }}
            >
              <span className="episode-graph-kind">{node.kind}</span>
              <strong>{node.label}</strong>
              <span>
                {node.operationCount} operations · {node.issueCount} issues
              </span>
              <StatusPill state={node.state} />
            </button>
          ))}
        </div>
      )}
      <p className="episode-bounded-note">Graph pages render every node in the bounded GraphProjection/v1 without fixed clipping. The table alternative exposes all {graph.edges.length} projected edges and their evidence actions.</p>
    </div>
  );
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: string }) {
  return (
    <Card size="sm" className="episode-metric" data-tone={tone}>
      <CardContent>
        <span>{label}</span>
        <strong>{value}</strong>
      </CardContent>
    </Card>
  );
}

export function EvidenceEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="episode-empty">
      <span className="episode-empty-mark" aria-hidden="true">
        ◎
      </span>
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
