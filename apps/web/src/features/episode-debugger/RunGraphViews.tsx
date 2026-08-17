import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import SearchRemoveIcon from "@hugeicons/core-free-icons/SearchRemoveIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@q9labsai/chalk-ui";
import type { DiagnosticSnapshotV1 } from "@q9labsai/diagnostics-contracts";
import { useEffect, useState } from "react";
import { DiagnosticTable } from "./DiagnosticTable";
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
      <div className="episode-boundary-grid">
        <Card size="sm" data-episode-boundary="confirmed">
          <CardHeader>
            <CardTitle>Latest confirmed boundary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="episode-evidence-value">{run.latestConfirmedBoundary?.value ?? `unknown: ${run.latestConfirmedBoundary?.unknownReason ?? "not available"}`}</p>
          </CardContent>
        </Card>
        <Card size="sm" className="episode-card-warning" data-episode-boundary="broken">
          <CardHeader>
            <CardTitle>First broken boundary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="episode-evidence-value">{run.firstMissingBoundary?.value ?? `unknown: ${run.firstMissingBoundary?.unknownReason ?? "not available"}`}</p>
          </CardContent>
        </Card>
      </div>
      <div className="episode-release-mix">
        <span>
          {run.activeOperationCount} of {snapshot.summary.operationCount} operations active · observed release mix
        </span>
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
      <section aria-labelledby="participant-lanes-title">
        <div className="episode-section-heading">
          <div>
            <p className="episode-eyebrow">Receive order</p>
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
                  {lane.operationIds.length === 0 && <span className="episode-lane-empty">No operations projected at this cursor</span>}
                  {lane.operationIds.map((operationId, operationIndex) => {
                    const operation = snapshot.operations.find((candidate) => candidate.id === operationId);
                    return (
                      <button
                        key={operationId}
                        type="button"
                        className="episode-run-block"
                        data-tone={operation ? operation.state : "neutral"}
                        onClick={() => operation && onSelect({ kind: "operation", value: operation })}
                        title={operation ? `${operation.kind} · ${operation.state.replaceAll("_", " ")}` : `Unknown operation ${operationId}`}
                        aria-label={operation ? `${operation.kind}, ${operation.state.replaceAll("_", " ")}` : `Unknown operation ${operationId}`}
                      >
                        <span className="episode-run-block-order">{operationIndex + 1}</span>
                        <span className="episode-run-block-kind">{operation?.kind ?? "unknown"}</span>
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
        <HugeiconsIcon icon={InformationCircleIcon} size={18} strokeWidth={1.7} />

        <div>
          <strong>Whiteboard diagnostics are unsupported in v1</strong>
          <p>No whiteboard content or checkpoints are presented as complete.</p>
        </div>
      </div>
    </div>
  );
}

/* Node geometry, shared by the nodes and the connectors that must land on them.
   Widths are percentages so the two agree at any container size; heights are
   pixels because the rows are fixed-pitch. */
const GRAPH_MAX_COLUMNS = 4;
const GRAPH_MIN_COLUMN_PIXELS = 168;
const GRAPH_COLUMN_GAP_PERCENT = 3;
const GRAPH_ROW_PITCH = 150;
const GRAPH_ROW_INSET = 26;
const GRAPH_NODE_HEIGHT = 106;

type GraphGeometry = Readonly<{ columns: number; nodeWidth: number; left: (index: number) => number; top: (index: number) => number; centerX: (index: number) => string; centerY: (index: number) => number; height: (nodeCount: number) => number }>;

function graphGeometry(columns: number): GraphGeometry {
  const pitch = 100 / columns;
  const nodeWidth = pitch - GRAPH_COLUMN_GAP_PERCENT;
  const left = (index: number) => (index % columns) * pitch + GRAPH_COLUMN_GAP_PERCENT / 2;
  const top = (index: number) => Math.floor(index / columns) * GRAPH_ROW_PITCH + GRAPH_ROW_INSET;
  return {
    columns,
    nodeWidth,
    left,
    top,
    centerX: (index) => `${left(index) + nodeWidth / 2}%`,
    centerY: (index) => top(index) + GRAPH_NODE_HEIGHT / 2,
    height: (nodeCount) => top(Math.max(0, nodeCount - 1)) + GRAPH_NODE_HEIGHT + GRAPH_ROW_INSET,
  };
}

/* The column count has to come from the measured container, not a media query:
   the connectors are drawn from the same numbers and would drift otherwise. */
function useGraphColumns(): readonly [(element: HTMLDivElement | null) => void, number] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(GRAPH_MAX_COLUMNS);
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setColumns(Math.max(1, Math.min(GRAPH_MAX_COLUMNS, Math.floor(width / GRAPH_MIN_COLUMN_PIXELS))));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, columns] as const;
}

export function GraphView({ snapshot, onSelect }: { snapshot: DiagnosticSnapshotV1; onSelect: (selection: DebuggerSelection) => void }) {
  const [tableMode, setTableMode] = useState(false);
  const [page, setPage] = useState(0);
  const [graphRef, columns] = useGraphColumns();
  const geometry = graphGeometry(columns);
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
        <div ref={graphRef} className="episode-graph" aria-label={`Causal system graph, node page ${boundedPage + 1} of ${pageCount}`} style={{ blockSize: `${geometry.height(visibleNodes.length)}px` }}>
          {/* No viewBox: the connectors then share the nodes' own percentage and
              pixel coordinate space instead of a second, drifting one. */}
          <svg className="episode-graph-lines" aria-hidden="true">
            {visibleEdges.map((edge, index) => {
              const fromIndex = Math.max(
                0,
                visibleNodes.findIndex((node) => node.id === edge.from),
              );
              const toIndex = Math.max(
                0,
                visibleNodes.findIndex((node) => node.id === edge.to),
              );
              return <line key={`${edge.id}-${index}`} x1={geometry.centerX(fromIndex)} y1={geometry.centerY(fromIndex)} x2={geometry.centerX(toIndex)} y2={geometry.centerY(toIndex)} data-tone={edge.state} />;
            })}
          </svg>
          {visibleNodes.map((node, index) => (
            <button
              type="button"
              key={node.id}
              className="episode-graph-node"
              data-tone={node.state}
              style={{ blockSize: `${GRAPH_NODE_HEIGHT}px`, inlineSize: `${geometry.nodeWidth}%`, insetInlineStart: `${geometry.left(index)}%`, insetBlockStart: `${geometry.top(index)}px` }}
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

export function EvidenceEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="episode-empty">
      <HugeiconsIcon className="episode-empty-mark" icon={SearchRemoveIcon} size={26} strokeWidth={1.5} />
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
