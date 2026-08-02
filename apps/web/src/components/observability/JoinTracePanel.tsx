import type { ChalkSessionJoinTraceEvent, ChalkSessionJoinTraceStep } from "@q9labsai/chalk-client";
import { useMemo, useState, type CSSProperties } from "react";

type JoinTraceView = "timeline" | "graph" | "flame";
type JoinTraceSpanOutcome = "in_flight" | "succeeded" | "failed" | "cancelled";

export type JoinTraceSpan = {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly step: ChalkSessionJoinTraceStep;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly outcome: JoinTraceSpanOutcome;
  readonly state: ChalkSessionJoinTraceEvent["state"];
  readonly epoch: number;
  readonly code?: ChalkSessionJoinTraceEvent["code"];
};

const stepLabels: Record<ChalkSessionJoinTraceStep, string> = {
  join: "Join",
  acquire_initial_media: "Acquire initial media",
  access_initialize: "Initialize access",
  create_media_client: "Create media client",
  create_sync_client: "Create Sync client",
  start_media: "Start media",
  start_sync: "Start Sync",
  wait_for_sync_live: "Wait for Sync live",
};

const stepPhases: Record<ChalkSessionJoinTraceStep, string> = {
  join: "lifecycle",
  acquire_initial_media: "media",
  access_initialize: "access",
  create_media_client: "media",
  create_sync_client: "sync",
  start_media: "media",
  start_sync: "sync",
  wait_for_sync_live: "sync",
};

export function buildJoinTraceSpans(events: readonly ChalkSessionJoinTraceEvent[]): readonly JoinTraceSpan[] {
  const starts = new Map<string, ChalkSessionJoinTraceEvent>();
  const spans = new Map<string, JoinTraceSpan>();

  for (const event of events) {
    if (event.outcome === "started") {
      starts.set(event.spanId, event);
      continue;
    }

    const started = starts.get(event.spanId);
    spans.set(event.spanId, {
      spanId: event.spanId,
      ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
      step: event.step,
      startedAt: started?.timestamp ?? event.timestamp - (event.durationMs ?? 0),
      durationMs: event.durationMs ?? 0,
      outcome: event.outcome,
      state: event.state,
      epoch: event.epoch,
      ...(event.code ? { code: event.code } : {}),
    });
  }

  for (const event of starts.values()) {
    if (spans.has(event.spanId)) continue;
    spans.set(event.spanId, {
      spanId: event.spanId,
      ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
      step: event.step,
      startedAt: event.timestamp,
      durationMs: Math.max(0, Date.now() - event.timestamp),
      outcome: "in_flight",
      state: event.state,
      epoch: event.epoch,
    });
  }

  return Object.freeze([...spans.values()].sort((left, right) => left.startedAt - right.startedAt));
}

export function JoinTracePanel({ events, onClose }: { readonly events: readonly ChalkSessionJoinTraceEvent[]; readonly onClose?: () => void }) {
  const [view, setView] = useState<JoinTraceView>("timeline");
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const spans = useMemo(() => buildJoinTraceSpans(events), [events]);
  const root = spans.find((span) => span.step === "join") ?? null;
  const selected = spans.find((span) => span.spanId === selectedSpanId) ?? root ?? spans[0] ?? null;
  const status = root?.outcome === "succeeded" ? "live" : root?.outcome === "failed" || root?.outcome === "cancelled" ? "failed" : root ? "joining" : "waiting";
  const totalDuration = root?.durationMs ?? spans.reduce((total, span) => Math.max(total, span.startedAt - (root?.startedAt ?? span.startedAt) + span.durationMs), 0);

  return (
    <aside className="chalk-join-trace" aria-label="Chalk join trace">
      <header className="chalk-join-trace__header">
        <div>
          <p className="chalk-join-trace__eyebrow">Local room / join trace</p>
          <h1>Chalk join path</h1>
        </div>
        <div className="chalk-join-trace__header-actions">
          <span className={`chalk-join-trace__status chalk-join-trace__status--${status}`} role="status" aria-label={`Join status: ${status}`}>
            <span aria-hidden="true" />
            {status}
          </span>
          {onClose ? (
            <button type="button" className="chalk-join-trace__icon-button" onClick={onClose} aria-label="Hide join trace">
              ×
            </button>
          ) : null}
        </div>
      </header>

      <div className="chalk-join-trace__summary" aria-live="polite">
        <strong>{spans.length} spans</strong>
        <span>{formatDuration(totalDuration)}</span>
        <span>{root ? `${root.epoch} epoch` : "Waiting for a Chalk session"}</span>
      </div>

      <nav className="chalk-join-trace__tabs" aria-label="Join trace views">
        {(["timeline", "graph", "flame"] as const).map((nextView) => (
          <button key={nextView} type="button" className={view === nextView ? "is-active" : undefined} aria-pressed={view === nextView} onClick={() => setView(nextView)}>
            {nextView === "timeline" ? "Timeline" : nextView === "graph" ? "Graph" : "Flame"}
          </button>
        ))}
      </nav>

      <div className="chalk-join-trace__body">
        {spans.length === 0 ? (
          <EmptyTrace />
        ) : view === "timeline" ? (
          <TimelineView spans={spans} selectedSpanId={selected?.spanId ?? null} onSelect={setSelectedSpanId} />
        ) : view === "graph" ? (
          <GraphView spans={spans} selectedSpanId={selected?.spanId ?? null} onSelect={setSelectedSpanId} />
        ) : (
          <FlameView spans={spans} selectedSpanId={selected?.spanId ?? null} onSelect={setSelectedSpanId} />
        )}
      </div>

      {selected ? <SpanDetails span={selected} /> : null}
    </aside>
  );
}

function TimelineView({ spans, selectedSpanId, onSelect }: { readonly spans: readonly JoinTraceSpan[]; readonly selectedSpanId: string | null; readonly onSelect: (spanId: string) => void }) {
  return (
    <div className="chalk-join-trace__timeline" role="list" aria-label="Join trace timeline">
      {spans.map((span) => (
        <TraceRow key={span.spanId} span={span} selected={span.spanId === selectedSpanId} onSelect={onSelect} />
      ))}
    </div>
  );
}

function TraceRow({ span, selected, onSelect }: { readonly span: JoinTraceSpan; readonly selected: boolean; readonly onSelect: (spanId: string) => void }) {
  return (
    <button type="button" className={`chalk-join-trace__row${selected ? " is-selected" : ""}`} style={{ "--trace-depth": span.parentSpanId ? 1 : 0 } as CSSProperties} aria-pressed={selected} onClick={() => onSelect(span.spanId)}>
      <span className={`chalk-join-trace__node chalk-join-trace__node--${span.outcome}`} aria-hidden="true" />
      <span className="chalk-join-trace__row-copy">
        <span className="chalk-join-trace__row-title">{stepLabels[span.step]}</span>
        <span className="chalk-join-trace__row-meta">
          {stepPhases[span.step]} · {span.outcome === "in_flight" ? "in flight" : formatDuration(span.durationMs)}
        </span>
      </span>
      <span className={`chalk-join-trace__outcome chalk-join-trace__outcome--${span.outcome}`}>{outcomeLabel(span.outcome)}</span>
    </button>
  );
}

function GraphView({ spans, selectedSpanId, onSelect }: { readonly spans: readonly JoinTraceSpan[]; readonly selectedSpanId: string | null; readonly onSelect: (spanId: string) => void }) {
  const children = new Map<string | undefined, JoinTraceSpan[]>();
  for (const span of spans) children.set(span.parentSpanId, [...(children.get(span.parentSpanId) ?? []), span]);
  const roots = children.get(undefined) ?? spans.filter((span) => !span.parentSpanId);

  return (
    <div className="chalk-join-trace__graph" role="tree" aria-label="Join trace span graph">
      {roots.map((span) => (
        <GraphNode key={span.spanId} span={span} children={children} selectedSpanId={selectedSpanId} onSelect={onSelect} />
      ))}
    </div>
  );
}

function GraphNode({ span, children, selectedSpanId, onSelect }: { readonly span: JoinTraceSpan; readonly children: ReadonlyMap<string | undefined, readonly JoinTraceSpan[]>; readonly selectedSpanId: string | null; readonly onSelect: (spanId: string) => void }) {
  return (
    <div className="chalk-join-trace__graph-node" role="treeitem" aria-selected={span.spanId === selectedSpanId}>
      <button type="button" className={`chalk-join-trace__graph-card${span.spanId === selectedSpanId ? " is-selected" : ""}`} onClick={() => onSelect(span.spanId)}>
        <span className={`chalk-join-trace__node chalk-join-trace__node--${span.outcome}`} aria-hidden="true" />
        <span>
          <strong>{stepLabels[span.step]}</strong>
          <small>
            {formatDuration(span.durationMs)} · {outcomeLabel(span.outcome)}
          </small>
        </span>
      </button>
      {(children.get(span.spanId) ?? []).length > 0 ? (
        <div className="chalk-join-trace__graph-children" role="group">
          {(children.get(span.spanId) ?? []).map((child) => (
            <GraphNode key={child.spanId} span={child} children={children} selectedSpanId={selectedSpanId} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FlameView({ spans, selectedSpanId, onSelect }: { readonly spans: readonly JoinTraceSpan[]; readonly selectedSpanId: string | null; readonly onSelect: (spanId: string) => void }) {
  const start = spans[0]?.startedAt ?? 0;
  const end = Math.max(...spans.map((span) => span.startedAt + span.durationMs), start + 1);
  const range = Math.max(1, end - start);

  return (
    <div className="chalk-join-trace__flame" role="list" aria-label="Join trace flame view">
      <div className="chalk-join-trace__flame-axis" aria-hidden="true">
        <span>0 ms</span>
        <span>{formatDuration(range)}</span>
      </div>
      {spans.map((span) => (
        <button key={span.spanId} type="button" className={`chalk-join-trace__flame-row${span.spanId === selectedSpanId ? " is-selected" : ""}`} onClick={() => onSelect(span.spanId)} aria-pressed={span.spanId === selectedSpanId}>
          <span className="chalk-join-trace__flame-label">{stepLabels[span.step]}</span>
          <span className="chalk-join-trace__flame-track">
            <span className={`chalk-join-trace__flame-bar chalk-join-trace__flame-bar--${stepPhases[span.step]} chalk-join-trace__flame-bar--${span.outcome}`} style={{ left: `${((span.startedAt - start) / range) * 100}%`, width: `${Math.max(1.5, (span.durationMs / range) * 100)}%` }} />
          </span>
          <span className="chalk-join-trace__flame-duration">{formatDuration(span.durationMs)}</span>
        </button>
      ))}
    </div>
  );
}

function SpanDetails({ span }: { readonly span: JoinTraceSpan }) {
  return (
    <section className="chalk-join-trace__details" aria-label="Selected span details">
      <div className="chalk-join-trace__details-heading">
        <span>Selected span</span>
        <strong>{stepLabels[span.step]}</strong>
      </div>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>{outcomeLabel(span.outcome)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(span.durationMs)}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{span.state}</dd>
        </div>
        <div>
          <dt>Phase</dt>
          <dd>{stepPhases[span.step]}</dd>
        </div>
        {span.code ? (
          <div>
            <dt>Failure code</dt>
            <dd className="is-failure">{span.code}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function EmptyTrace() {
  return (
    <div className="chalk-join-trace__empty">
      <span className="chalk-join-trace__empty-mark" aria-hidden="true">
        ⌁
      </span>
      <strong>Awaiting a Chalk join</strong>
      <span>Start the local room and the spans will appear here as the session moves through access, media, and Sync.</span>
    </div>
  );
}

function outcomeLabel(outcome: JoinTraceSpanOutcome): string {
  if (outcome === "in_flight") return "running";
  if (outcome === "succeeded") return "ok";
  if (outcome === "cancelled") return "cancelled";
  return "failed";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1) return "<1 ms";
  return `${Math.round(milliseconds)} ms`;
}
