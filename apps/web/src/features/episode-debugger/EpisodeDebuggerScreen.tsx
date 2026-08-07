import { Button, Input, ToastProvider, ToastViewport, toast } from "@q9labsai/chalk-ui";
import { formatDiagnosticReference, parseDiagnosticReference, parseDiagnosticFilter, renderAgentBriefMarkdown, type DiagnosticFilterV1 } from "@chalk/diagnostics-contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { EpisodeDiagnosticsApiClient } from "./api-client";
import { selectClipboardFallback, writeClipboardText } from "./clipboard";
import { DetailsPanel } from "./DetailsPanel";
import { EpilogueView, IssuesView, ParticipantsView } from "./EntityViews";
import { DiagnosticExportController, type DiagnosticExportState } from "./export-controller";
import { DiagnosticLiveController, type DiagnosticLiveState } from "./live-controller";
import { DEBUGGER_VIEWS, formatDuration, type DebuggerSelection, type DebuggerView } from "./model";
import { GraphView, RunView } from "./RunGraphViews";
import { StatusPill } from "./StatusPill";
import { FlameView, TraceView } from "./TraceFlameViews";
import { createInitialDiagnosticLiveState } from "./live-controller";
import type { EpisodeDiagnosticsMode } from "../../lib/episode-diagnostics-config";
import "./episode-debugger.css";

const EMPTY_FILTER: DiagnosticFilterV1 = { schemaVersion: "DiagnosticFilter/v1" };
const MAX_CLIPBOARD_MARKDOWN = 750_000;

export default function EpisodeDebuggerRoute() {
  const params = useParams({ strict: false }) as { reference?: string };
  return <EpisodeDebuggerScreen reference={params.reference ?? ""} />;
}

export function EpisodeDebuggerScreen({ reference, api: apiInput, mode = __EPISODE_DIAGNOSTICS_MODE__ }: { reference: string; api?: EpisodeDiagnosticsApiClient; mode?: EpisodeDiagnosticsMode }) {
  const api = useMemo(() => apiInput ?? new EpisodeDiagnosticsApiClient(), [apiInput]);
  const [view, setView] = useState<DebuggerView>("run");
  const [selection, setSelection] = useState<DebuggerSelection>();
  const [filter, setFilter] = useState<DiagnosticFilterV1>(EMPTY_FILTER);
  const [filterDraft, setFilterDraft] = useState<Record<string, string>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [liveState, setLiveState] = useState<DiagnosticLiveState>(() => createInitialDiagnosticLiveState(EMPTY_FILTER));
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [filterStatus, setFilterStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [exportState, setExportState] = useState<DiagnosticExportState>({ phase: "idle" });
  const [announcement, setAnnouncement] = useState("");
  const [resolvedAlternateReference, setResolvedAlternateReference] = useState<string>();
  const [alternateStatus, setAlternateStatus] = useState<"idle" | "resolving" | "failed">("idle");
  const [fallbackText, setFallbackText] = useState("");
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const controllerRef = useRef<DiagnosticLiveController | undefined>(undefined);
  const canonicalInputReference = useMemo(() => {
    try {
      parseDiagnosticReference(reference);
      return reference;
    } catch {
      return undefined;
    }
  }, [reference]);
  const alternateReference = !canonicalInputReference && /^[a-z][a-z0-9._-]{0,63}[:/][A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(reference) ? reference : undefined;
  const effectiveReference = canonicalInputReference ?? resolvedAlternateReference;
  const parsedReference = useMemo(() => {
    try {
      const parsed = parseDiagnosticReference(effectiveReference);
      return {
        parsed,
        umbrella: formatDiagnosticReference({ version: 1, environment: parsed.environment, diagnosticId: parsed.diagnosticId }),
      };
    } catch {
      return undefined;
    }
  }, [effectiveReference]);
  const normalizedReference = parsedReference?.umbrella;

  useEffect(() => {
    setResolvedAlternateReference(undefined);
    setAlternateStatus(alternateReference ? "resolving" : "idle");
    if (!alternateReference || mode === "off") return;
    const abort = new AbortController();
    void api
      .resolveAlternate(alternateReference, abort.signal)
      .then((resolved) => {
        setResolvedAlternateReference(resolved);
        setAlternateStatus("idle");
      })
      .catch((error) => {
        setAlternateStatus("failed");
        setAnnouncement(error instanceof Error ? error.message : "The alternate Diagnostic Reference could not be resolved.");
      });
    return () => abort.abort();
  }, [alternateReference, api, mode]);

  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    if (!normalizedReference || mode === "off") return;
    setLiveState(createInitialDiagnosticLiveState(filter));
    setFilterStatus("loading");
    const controller = new DiagnosticLiveController({ api, reference: normalizedReference, filter, onChange: setLiveState });
    controllerRef.current = controller;
    void controller.start();
    return () => {
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = undefined;
    };
  }, [api, filterKey, mode, normalizedReference, retryGeneration]);

  useEffect(() => {
    if (liveState.phase === "failed") setFilterStatus("error");
    else if (liveState.snapshot) setFilterStatus("ready");
  }, [liveState.phase, liveState.snapshot]);

  useEffect(() => {
    if (!parsedReference?.parsed.focus || mode === "off") return;
    const abort = new AbortController();
    void api
      .resolve(effectiveReference ?? reference, abort.signal)
      .then((resolved) => {
        if (resolved.kind === "operation") setSelection({ kind: "operation", value: resolved.operation });
        if (resolved.kind === "issue") setSelection({ kind: "issue", value: resolved.issue });
        if (resolved.kind === "event") setSelection({ kind: "event", value: resolved.event });
      })
      .catch((error) => setAnnouncement(error instanceof Error ? error.message : "The focused Diagnostic Reference could not be resolved."));
    return () => abort.abort();
  }, [api, effectiveReference, mode, parsedReference, reference]);

  useEffect(() => {
    setSelection((current) => reconcileSelection(current, liveState));
  }, [liveState.events, liveState.operations, liveState.snapshot]);

  const exportController = useMemo(() => (normalizedReference ? new DiagnosticExportController({ api, reference: normalizedReference, onChange: setExportState }) : undefined), [api, normalizedReference]);
  useEffect(() => {
    if (!exportController) return;
    return () => stopExportController(exportController);
  }, [exportController]);
  useEffect(() => {
    if (!fallbackText || !fallbackRef.current) return;
    selectClipboardFallback(fallbackRef.current);
  }, [fallbackText]);
  useEffect(() => {
    if (exportState.phase === "ready") toast.success({ title: "Diagnostic bundle ready", description: "The authenticated download is ready." });
    if (exportState.phase === "failed") toast.error({ title: "Export failed", description: exportState.error ?? "The export job did not complete." });
    if (exportState.phase === "cancelled") toast.info({ title: "Export cancelled" });
  }, [exportState.error, exportState.phase]);

  const copyText = async (text: string, label: string): Promise<void> => {
    const result = await writeClipboardText(text);
    if (result.copied) {
      setAnnouncement(`${label} copied.`);
      toast.success({ title: `${label} copied` });
      setFallbackText("");
      return;
    }
    setFallbackText(text);
    setAnnouncement(`${label} selected. Press ${navigator.platform.includes("Mac") ? "Command" : "Control"}+C to copy.`);
    toast.warning({ title: "Clipboard unavailable", description: "The prepared text is selected. Use the keyboard copy command." });
  };

  const copyBrief = async (format: "compact" | "markdown"): Promise<void> => {
    if (!normalizedReference) return;
    setAnnouncement(format === "compact" ? "Preparing AgentBrief/v1." : "Preparing complete AgentBrief/v1 Markdown.");
    try {
      const focusedReference = focusedDiagnosticReference(selection, normalizedReference) ?? normalizedReference;
      const briefQuery = { cursor: liveState.lastAppliedCursor, ...briefWindow(filter), ...(selection?.kind === "branch" ? { branchId: selection.value.id } : {}) };
      const response = await api.readBrief(focusedReference, format, briefQuery);
      const prepared = renderAgentBriefMarkdown(response.brief);
      if (format === "markdown" && prepared.length > MAX_CLIPBOARD_MARKDOWN) {
        const compact = await api.readBrief(focusedReference, "compact", briefQuery);
        const exportJob = await api.createExportJob(normalizedReference, liveState.lastAppliedCursor);
        const fallback = `${renderAgentBriefMarkdown(compact.brief)}\n\nFull Markdown omitted: ${prepared.length} characters exceeds the clipboard safety limit.\nExport job reference: ${exportJob.jobId}`;
        await copyText(fallback, "Compact AgentBrief with export reference");
        return;
      }
      await copyText(prepared, format === "compact" ? "AgentBrief" : "AgentBrief Markdown");
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : "The AgentBrief could not be copied.");
    }
  };

  if (!normalizedReference && alternateReference && alternateStatus === "resolving") return <Refusal title="Resolving Diagnostic Reference" detail="The environment gateway is resolving this alternate identifier to a canonical chalkdiag:v1 reference." />;
  if (!normalizedReference && alternateReference && alternateStatus === "failed") return <Refusal title="Diagnostic Reference could not be resolved" detail={announcement || "The environment gateway rejected this alternate identifier."} />;
  if (!normalizedReference) return <Refusal title="Invalid Diagnostic Reference" detail="Use the canonical chalkdiag:v1 reference supplied by the Episode Diagnostic service." />;
  if (mode === "off") return <Refusal title="Episode Diagnostics are off" detail="This build does not register the debugger route when diagnostics mode is off." />;
  if (mode === "localhost" && !["localhost", "127.0.0.1", "[::1]"].includes(globalThis.location.hostname)) return <Refusal title="Localhost origin required" detail="Local diagnostics refuse non-loopback browser origins." />;
  const snapshot = liveState.snapshot;

  return (
    <main className="chalk-root episode-debugger" data-chalk data-chalk-theme="light" data-chalk-palette="light" data-episode-stream-state={liveState.phase}>
      <header className="episode-topbar">
        <div className="episode-brand">
          <span className="episode-brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>chalk</span>
          <span className="episode-product-name">Episode Debugger</span>
        </div>
        <div className="episode-reference-block">
          <span className="episode-eyebrow">Diagnostic Reference</span>
          <code title={reference}>{reference}</code>
        </div>
        <div className="episode-top-status">
          <span className="episode-environment">{snapshot?.environment ?? "resolving"}</span>
          <StatusPill state={snapshot?.state ?? "loading"} />
          <span className="episode-mono">{formatDuration(snapshot?.run?.elapsedMilliseconds)}</span>
          <span className="episode-mono">
            c {snapshot?.committedCursor ?? "—"} / p {snapshot?.projectedCursor ?? "—"}
          </span>
          <span className="episode-mono">lag {snapshot ? Math.max(0, snapshot.committedCursor - snapshot.projectedCursor) : "—"}</span>
          <span className="episode-heartbeat">activity {liveState.lastActivityAt ? new Date(liveState.lastActivityAt).toLocaleTimeString() : "waiting"}</span>
          <span className="episode-retention">Retention · 7 days after completion</span>
          <StatusPill state={liveState.phase} label={streamLabel(liveState)} />
        </div>
        <div className="episode-top-actions">
          <Button variant="outline" data-episode-action="copy-reference" onClick={() => void copyText(normalizedReference, "Diagnostic Reference")}>
            Copy reference
          </Button>
          <Button variant="outline" data-episode-action="copy-all" onClick={() => void copyBrief("markdown")}>
            Copy all
          </Button>
          <Button variant="outline" data-episode-action="download-json" onClick={() => void exportController?.start(liveState.lastAppliedCursor)} disabled={!snapshot || exportState.phase === "starting" || exportState.phase === "polling"}>
            Download JSON
          </Button>
          <Button data-episode-action="copy-agent" onClick={() => void copyBrief("compact")}>
            Copy for Agent
          </Button>
        </div>
      </header>

      <div className="episode-shell">
        <nav className="episode-nav" aria-label="Debugger views">
          {DEBUGGER_VIEWS.map((item) => (
            <Button key={item} data-episode-view={item} variant={view === item ? "secondary" : "ghost"} aria-current={view === item ? "page" : undefined} onClick={() => setView(item)}>
              <span className="episode-nav-icon" aria-hidden="true">
                {viewIcon(item)}
              </span>
              <span>{viewLabel(item)}</span>
              {item === "issues" && snapshot?.summary.openIssueCount ? <b>{snapshot.summary.openIssueCount}</b> : null}
            </Button>
          ))}
        </nav>
        <section className="episode-canvas" aria-label={`${viewLabel(view)} view`}>
          <div className="episode-canvas-header">
            <div>
              <p className="episode-eyebrow">Live semantic evidence</p>
              <h1>{viewLabel(view)}</h1>
              <p>{viewDescription(view)}</p>
            </div>
            <div className="episode-time-controls">
              <span className="episode-mono">projected {snapshot?.projectedCursor ?? "—"}</span>
              <Button variant="outline" size="sm" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)}>
                Filters{Object.keys(filter).length > 1 ? ` · ${Object.keys(filter).length - 1}` : ""}
              </Button>
            </div>
          </div>
          {filtersOpen && (
            <FilterPanel
              draft={filterDraft}
              setDraft={setFilterDraft}
              apply={() => {
                try {
                  setFilter(buildFilter(filterDraft));
                  setFilterStatus("loading");
                  setAnnouncement("Applying filters and loading a fresh bounded snapshot.");
                } catch (error) {
                  setFilterStatus("error");
                  setAnnouncement(error instanceof Error ? error.message : "The filters are invalid.");
                }
              }}
              clear={() => {
                setFilterDraft({});
                setFilter(EMPTY_FILTER);
                setFilterStatus("loading");
              }}
            />
          )}
          {filterStatus !== "idle" && (
            <p className="episode-filter-status" role={filterStatus === "error" ? "alert" : "status"} data-state={filterStatus}>
              {filterStatus === "loading" ? "Loading filtered evidence…" : filterStatus === "error" ? (liveState.error ?? announcement) : `Filters ready at projected cursor ${snapshot?.projectedCursor ?? "—"}.`}
            </p>
          )}
          {liveState.fillingGap && (
            <div className="episode-stream-banner" data-episode-gap role="status">
              <span className="episode-spinner" aria-hidden="true" />
              Filling durable cursor gap {liveState.fillingGap.fromCursor}–{liveState.fillingGap.toCursor}. Selection, filters, and zoom are preserved.
            </div>
          )}
          {!liveState.fillingGap && liveState.visibleGaps.at(-1) && (
            <div className="episode-stream-banner" data-episode-gap data-tone="warning" role="status">
              Preserved visibility gap {liveState.visibleGaps.at(-1)?.fromCursor}–{liveState.visibleGaps.at(-1)?.toCursor}: {liveState.visibleGaps.at(-1)?.reason.replaceAll("_", " ")}.
            </div>
          )}
          {(liveState.phase === "reconnecting" || liveState.phase === "stalled") && (
            <div className="episode-stream-banner" data-tone="warning" role="status">
              {liveState.phase === "stalled" ? "Stream heartbeat is late. The product state is separate; evidence may be delayed." : `Reconnecting from confirmed cursor ${liveState.lastAppliedCursor}.`}
            </div>
          )}
          {(liveState.phase === "disconnected" || liveState.phase === "failed") && (
            <div className="episode-stream-banner" data-tone="warning" role="status">
              <span>{liveState.phase === "failed" ? (liveState.error ?? "Evidence loading failed.") : "The evidence stream is disconnected."}</span>
              <Button data-episode-action="retry-stream" size="sm" variant="outline" onClick={() => setRetryGeneration((value) => value + 1)}>
                Retry evidence
              </Button>
            </div>
          )}
          <div className="episode-canvas-body">
            {snapshot ? (
              renderView(
                view,
                liveState,
                selection,
                setSelection,
                () => {
                  const controller = controllerRef.current;
                  if (controller) loadMoreEvents(controller);
                },
                () => {
                  const controller = controllerRef.current;
                  if (controller) loadMoreOperations(controller);
                },
                (nextFilter) => {
                  setFilterDraft(filterToDraft(nextFilter));
                  setFilter(nextFilter);
                  setFilterStatus("loading");
                  setView("trace");
                },
              )
            ) : liveState.phase === "failed" ? (
              <FailureView error={liveState.error} onRetry={() => setRetryGeneration((value) => value + 1)} />
            ) : (
              <LoadingView />
            )}
          </div>
        </section>
        {snapshot ? (
          <DetailsPanel
            snapshot={snapshot}
            selection={selection}
            onSelect={setSelection}
            onCopy={(text, label) => void copyText(text, label)}
            onOpenRelated={(nextFilter) => {
              setFilterDraft(filterToDraft(nextFilter));
              setFilter(nextFilter);
              setFilterStatus("loading");
              setView("trace");
            }}
          />
        ) : (
          <aside className="episode-details-panel">
            <LoadingLines />
          </aside>
        )}
      </div>

      {exportState.phase !== "idle" && <ExportToast state={exportState} downloadUrl={exportController?.downloadUrl()} onCancel={() => void exportController?.cancel()} />}
      <div className="episode-announcement" role="status" aria-live="polite">
        {announcement}
      </div>
      <textarea ref={fallbackRef} className="episode-clipboard-fallback" aria-label="Selected copy fallback" readOnly value={fallbackText} onChange={() => undefined} />
      <ToastProvider>
        <ToastViewport />
      </ToastProvider>
    </main>
  );
}

function renderView(view: DebuggerView, liveState: DiagnosticLiveState, selection: DebuggerSelection | undefined, onSelect: (selection: DebuggerSelection) => void, onLoadMoreEvents: () => void, onLoadMoreOperations: () => void, onOpenRelated: (filter: DiagnosticFilterV1) => void) {
  const snapshot = liveState.snapshot;
  if (!snapshot) return <LoadingView />;
  if (view === "run") return <RunView snapshot={snapshot} onSelect={onSelect} />;
  if (view === "graph") return <GraphView snapshot={snapshot} onSelect={onSelect} />;
  if (view === "trace")
    return <TraceView snapshot={snapshot} operations={liveState.operations} events={liveState.events} eventPage={liveState.eventPage} operationPage={liveState.operationPage} selection={selection} onSelect={onSelect} onLoadMoreEvents={onLoadMoreEvents} onLoadMoreOperations={onLoadMoreOperations} />;
  if (view === "flame") return <FlameView snapshot={snapshot} selection={selection} onSelect={onSelect} />;
  if (view === "issues") return <IssuesView snapshot={snapshot} onSelect={onSelect} />;
  if (view === "participants") return <ParticipantsView snapshot={snapshot} onSelect={onSelect} onOpenRelated={onOpenRelated} />;
  return <EpilogueView snapshot={snapshot} onSelect={onSelect} />;
}

function stopExportController(controller: DiagnosticExportController): void {
  controller.stop();
}

function loadMoreEvents(controller: DiagnosticLiveController): void {
  void controller.loadMoreEvents();
}

function loadMoreOperations(controller: DiagnosticLiveController): void {
  void controller.loadMoreOperations();
}

function FilterPanel({ draft, setDraft, apply, clear }: { draft: Record<string, string>; setDraft: (value: Record<string, string>) => void; apply: () => void; clear: () => void }) {
  const field = (key: string, label: string, placeholder: string) => (
    <label>
      <span>{label}</span>
      <Input value={draft[key] ?? ""} placeholder={placeholder} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
    </label>
  );
  return (
    <form
      className="episode-filter-panel"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <div className="episode-filter-grid">
        {field("participantId", "Participant", "Opaque Participant ID")}
        {field("operationKind", "Capability / operation", "screen.start")}
        {field("source", "Source", "sdk, api, sync…")}
        {field("state", "State", "failed, stalled…")}
        {field("issueState", "Issue", "open or resolved")}
        {field("releaseId", "Release", "Release ID")}
        {field("journeyId", "Journey", "Journey ID")}
        {field("traceId", "Trace", "32-character trace ID")}
        {field("spanId", "Span", "16-character span ID")}
        {field("requestId", "Request", "Safe request ID")}
        {field("commandId", "Command", "Safe command ID")}
        {field("providerId", "Provider", "Allowlisted raw provider ID")}
        {field("fromCursor", "From cursor", "Durable cursor")}
        {field("toCursor", "To cursor", "Durable cursor")}
        {field("fromTime", "From time", "ISO date-time")}
        {field("toTime", "To time", "ISO date-time")}
        {field("aroundTime", "Around time", "ISO date-time center")}
        {field("aroundSeconds", "Around window", "1–3600 seconds")}
      </div>
      <div className="episode-filter-actions">
        <p>Trace and span are paired. Hashed or not-retained identifiers are not presented as raw values.</p>
        <Button type="button" variant="ghost" onClick={clear}>
          Clear
        </Button>
        <Button type="submit">Apply filters</Button>
      </div>
    </form>
  );
}

export function buildFilter(draft: Record<string, string>): DiagnosticFilterV1 {
  const supported = ["participantId", "operationKind", "source", "state", "issueState", "releaseId", "journeyId", "traceId", "spanId", "requestId", "commandId", "providerId", "fromTime", "toTime"] as const;
  const values: Record<string, string | number> = {};
  for (const key of supported) if (draft[key]?.trim()) values[key] = draft[key].trim();
  for (const key of ["fromCursor", "toCursor"] as const) {
    const cursor = draft[key]?.trim();
    if (!cursor) continue;
    if (!/^\d+$/.test(cursor)) throw new Error(`${key} must be a non-negative whole cursor`);
    values[key] = Number(cursor);
  }
  if (typeof values.fromCursor === "number" && typeof values.toCursor === "number" && values.fromCursor > values.toCursor) throw new Error("The cursor window must start at or before its end");
  if (typeof values.fromTime === "string" && typeof values.toTime === "string" && Date.parse(values.fromTime) > Date.parse(values.toTime)) throw new Error("The time window must start at or before its end");
  const aroundTime = draft.aroundTime?.trim();
  const aroundSecondsText = draft.aroundSeconds?.trim();
  if (aroundTime || aroundSecondsText) {
    if (!aroundTime || !/^\d+$/.test(aroundSecondsText ?? "")) throw new Error("Around time requires a whole-second window between 1 and 3600");
    const aroundSeconds = Number(aroundSecondsText);
    const center = Date.parse(aroundTime);
    if (!Number.isFinite(center) || aroundSeconds < 1 || aroundSeconds > 3_600) throw new Error("Around time requires a valid ISO time and a window between 1 and 3600 seconds");
    values.fromTime = new Date(center - aroundSeconds * 1_000).toISOString();
    values.toTime = new Date(center + aroundSeconds * 1_000).toISOString();
  }
  return parseDiagnosticFilter({ schemaVersion: "DiagnosticFilter/v1", ...values });
}

function focusedDiagnosticReference(selection: DebuggerSelection | undefined, umbrella: string): string | undefined {
  if (!selection || selection.kind === "edge" || selection.kind === "participant") return undefined;
  // Branch is not a focused-reference kind in the closed v1 grammar. Keep the
  // umbrella handoff instead of manufacturing an `op` reference for a branch.
  if (selection.kind === "branch") return undefined;
  if ("reference" in selection.value && typeof selection.value.reference === "string") return selection.value.reference;
  if ("diagnosticReference" in selection.value && typeof selection.value.diagnosticReference === "string") return selection.value.diagnosticReference;
  const parsed = parseDiagnosticReference(umbrella);
  const id = selection.kind === "event" ? String(selection.value.cursor) : selection.value.id;
  return formatDiagnosticReference({
    ...parsed,
    focus: { kind: selection.kind === "operation" ? "op" : selection.kind, id },
    ...(selection.kind === "event" ? { cursor: selection.value.cursor } : {}),
  });
}

function reconcileSelection(selection: DebuggerSelection | undefined, state: DiagnosticLiveState): DebuggerSelection | undefined {
  if (!selection) return undefined;
  if (selection.kind === "operation") return state.operations.find((item) => item.id === selection.value.id) ? { kind: "operation", value: state.operations.find((item) => item.id === selection.value.id)! } : selection;
  if (selection.kind === "issue") return state.snapshot?.issues.find((item) => item.id === selection.value.id) ? { kind: "issue", value: state.snapshot.issues.find((item) => item.id === selection.value.id)! } : selection;
  if (selection.kind === "event") return state.events.find((item) => item.eventId === selection.value.eventId) ? { kind: "event", value: state.events.find((item) => item.eventId === selection.value.eventId)! } : selection;
  if (selection.kind === "branch") return state.snapshot?.branches.find((item) => item.id === selection.value.id) ? { kind: "branch", value: state.snapshot.branches.find((item) => item.id === selection.value.id)! } : selection;
  if (selection.kind === "participant") return state.snapshot?.participants?.find((item) => item.participantId === selection.value.participantId) ? { kind: "participant", value: state.snapshot.participants.find((item) => item.participantId === selection.value.participantId)! } : selection;
  const edge = state.snapshot?.graph?.edges.find((item) => item.id === selection.value.id);
  return edge ? { kind: "edge", value: edge } : selection;
}

const filterToDraft = (filter: DiagnosticFilterV1): Record<string, string> =>
  Object.fromEntries(
    Object.entries(filter)
      .filter(([key]) => key !== "schemaVersion")
      .map(([key, value]) => [key, String(value)]),
  );

const briefWindow = (filter: DiagnosticFilterV1): Readonly<{ aroundSeconds?: number }> => {
  if (!filter.fromTime || !filter.toTime) return {};
  const aroundSeconds = Math.floor((Date.parse(filter.toTime) - Date.parse(filter.fromTime)) / 2_000);
  return Number.isFinite(aroundSeconds) && aroundSeconds >= 0 ? { aroundSeconds: Math.min(3_600, aroundSeconds) } : {};
};

function streamLabel(state: DiagnosticLiveState): string {
  if (state.fillingGap) return "Gap fill";
  if (state.phase === "live") return `Live · ${state.lastAppliedCursor}`;
  if (state.phase === "reconnecting") return `Reconnect ${state.reconnectAttempt}`;
  return state.phase;
}

function viewLabel(view: DebuggerView): string {
  if (view === "run") return "Run";
  if (view === "graph") return "Graph";
  if (view === "trace") return "Trace";
  if (view === "flame") return "Flame";
  if (view === "issues") return "Issues";
  if (view === "participants") return "Participants";
  return "Epilogue";
}

function viewIcon(view: DebuggerView): string {
  return ({ run: "▶", graph: "⌘", trace: "≡", flame: "▰", issues: "!", participants: "◉", epilogue: "◇" } as const)[view];
}

function viewDescription(view: DebuggerView): string {
  return (
    {
      run: "What is happening now across Participant and service lanes.",
      graph: "Causal boundaries and the evidence behind each relationship.",
      trace: "A server-paged, virtualized tree and table of Operations and Events.",
      flame: "Bounded work across time, with retries and periodic samples kept distinct.",
      issues: "Failures, missed confirmations, overruns, exhaustion, transitions, and gaps.",
      participants: "Anonymous Participant projections and their observable coverage.",
      epilogue: "Linked work that remains live after the immutable Episode run ends.",
    } as const
  )[view];
}

function Refusal({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="chalk-root episode-refusal" data-chalk data-chalk-theme="light" data-chalk-palette="light">
      <div>
        <span className="episode-brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <p className="episode-eyebrow">Episode Debugger</p>
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
    </main>
  );
}

function LoadingView() {
  return (
    <div className="episode-loading" aria-label="Loading Episode Diagnostic">
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
function LoadingLines() {
  return (
    <div className="episode-loading-lines" aria-label="Loading details">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function FailureView({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return (
    <div className="episode-empty" role="alert">
      <span className="episode-empty-mark" aria-hidden="true">
        !
      </span>
      <h2>Evidence unavailable</h2>
      <p>{error ?? "The bounded diagnostic snapshot could not be loaded."}</p>
      <Button data-episode-action="retry-stream" onClick={onRetry}>
        Retry evidence
      </Button>
    </div>
  );
}

function ExportToast({ state, downloadUrl, onCancel }: { state: DiagnosticExportState; downloadUrl?: string; onCancel: () => void }) {
  const running = state.phase === "starting" || state.phase === "polling" || state.phase === "cancelling";
  return (
    <div className="episode-export-toast" role="status" aria-live="polite">
      <div>
        <strong>{state.phase === "ready" ? "Diagnostic bundle ready" : state.phase === "failed" ? "Export failed" : state.phase === "cancelled" ? "Export cancelled" : "Preparing bounded JSON bundle"}</strong>
        <span>{state.error ?? (state.job ? `Job ${state.job.jobId} · ${state.job.state}` : "Creating export job")}</span>
      </div>
      {running && (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      )}
      {state.phase === "ready" && downloadUrl && (
        <Button size="sm" nativeButton={false} render={<a href={downloadUrl} />}>
          Download
        </Button>
      )}
    </div>
  );
}
