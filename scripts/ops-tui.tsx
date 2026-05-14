#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */

import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { getOpsIncident, getOpsOverview, listOpsIncidents, loadOpsConfig } from "./ops/api";
import { describeHeartbeat, describeMaintenance, describeMonitor, filterIncident, incidentGlyph, incidentSortTime, relativeAge, shortTime, statusColor, trimCell } from "./ops/format";
import type { NullableTimestamp, OpsConfig, OpsIncident, OpsIncidentDetails, OpsMaintenanceWindow, OpsOverview } from "./ops/types";

process.env.OTUI_USE_ALTERNATE_SCREEN = "true";

const colors = {
  bg: "#0f0e14",
  panel: "#171622",
  panelSoft: "#1f1d2b",
  text: "#ede7da",
  muted: "#9f9788",
  border: "#625b50",
  accent: "#f4a51c",
  ok: "#7dd3a3",
  warn: "#f4a51c",
  bad: "#f87171",
  info: "#93c5fd",
};

type Row =
  | { tag: "section"; id: string; label: string }
  | { tag: "incident"; id: string; incident: OpsIncident }
  | { tag: "signal"; id: string; label: string; status: string; at?: NullableTimestamp }
  | { tag: "maintenance"; id: string; window: OpsMaintenanceWindow }
  | { tag: "empty"; id: string; label: string };

type LoadState = { tag: "loading" } | { tag: "ready"; overview: OpsOverview; incidents: OpsIncident[]; refreshedAt: Date } | { tag: "error"; message: string };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeKey(event: KeyEvent) {
  return event.name.toLowerCase();
}

function isTextInput(event: KeyEvent) {
  return !event.ctrl && !event.meta && !event.option && event.sequence.length === 1 && event.sequence >= " " && event.sequence !== "\x7f";
}

function buildRows(state: LoadState, query: string): Row[] {
  if (state.tag !== "ready") return [];

  const active = state.incidents
    .filter((incident) => incident.status !== "resolved")
    .filter((incident) => filterIncident(incident, query))
    .sort((left, right) => incidentSortTime(right) - incidentSortTime(left));
  const recent = state.incidents
    .filter((incident) => incident.status === "resolved")
    .filter((incident) => filterIncident(incident, query))
    .sort((left, right) => incidentSortTime(right) - incidentSortTime(left));
  const monitors = state.overview.signals.monitors ?? [];
  const heartbeats = state.overview.signals.heartbeats ?? [];
  const maintenance = state.overview.maintenance ?? [];

  return [
    { tag: "section", id: "active-heading", label: "ACTIVE INCIDENTS" },
    ...(active.length > 0 ? active.map((incident) => ({ tag: "incident" as const, id: incident.incident_code, incident })) : [{ tag: "empty" as const, id: "active-empty", label: "No active incidents" }]),
    { tag: "section", id: "signals-heading", label: "SIGNALS" },
    ...monitors.map((signal) => ({ tag: "signal" as const, id: `monitor:${signal.monitor_key}`, label: describeMonitor(signal), status: signal.status, at: signal.checked_at })),
    ...heartbeats.map((signal) => ({ tag: "signal" as const, id: `heartbeat:${signal.heartbeat_key}`, label: describeHeartbeat(signal), status: signal.status, at: signal.event_at })),
    ...(monitors.length + heartbeats.length > 0 ? [] : [{ tag: "empty" as const, id: "signals-empty", label: "No signals received" }]),
    { tag: "section", id: "maintenance-heading", label: "MAINTENANCE" },
    ...(maintenance.length > 0 ? maintenance.map((window) => ({ tag: "maintenance" as const, id: `maintenance:${window.id}`, window })) : [{ tag: "empty" as const, id: "maintenance-empty", label: "No scheduled maintenance" }]),
    { tag: "section", id: "recent-heading", label: "RECENT RESOLVED" },
    ...(recent.length > 0 ? recent.slice(0, 20).map((incident) => ({ tag: "incident" as const, id: incident.incident_code, incident })) : [{ tag: "empty" as const, id: "recent-empty", label: "No resolved incidents" }]),
  ];
}

function selectableRows(rows: Row[]) {
  return rows.filter((row) => row.tag !== "section" && row.tag !== "empty");
}

function rowFg(row: Row, selected: boolean) {
  if (selected) return colors.text;
  if (row.tag === "section") return colors.accent;
  if (row.tag === "empty") return colors.muted;
  if (row.tag === "incident") return statusColor(row.incident.status === "resolved" ? "resolved" : row.incident.severity);
  if (row.tag === "signal") return statusColor(row.status);
  return colors.info;
}

function rowText(row: Row, width: number) {
  if (row.tag === "section") return trimCell(` ${row.label}`, width);
  if (row.tag === "empty") return trimCell(`  - ${row.label}`, width);
  if (row.tag === "signal") return trimCell(` ${row.label}  ${relativeAge(row.at)}`, width);
  if (row.tag === "maintenance") return trimCell(` ${describeMaintenance(row.window)}`, width);

  const incident = row.incident;
  const publicMark = incident.visibility === "public" ? "pub" : "int";
  const updated = relativeAge(incident.last_seen_at ?? incident.updated_at ?? incident.created_at);
  return trimCell(` ${incidentGlyph(incident)} ${incident.incident_code} ${incident.severity}/${incident.status}/${publicMark} ${incident.title} ${updated}`, width);
}

function useOpsData(config: OpsConfig) {
  const [state, setState] = useState<LoadState>({ tag: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((current) => (current.tag === "ready" ? current : { tag: "loading" }));
    void Promise.all([getOpsOverview(config), listOpsIncidents(config, 80)]).then(
      ([overview, incidents]) => {
        if (cancelled) return;
        setState({ tag: "ready", overview, incidents, refreshedAt: new Date() });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ tag: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [config, refreshNonce]);

  return { state, refresh: () => setRefreshNonce((value) => value + 1) };
}

function useIncidentDetails(config: OpsConfig, incidentCode: string | null) {
  const [details, setDetails] = useState<OpsIncidentDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!incidentCode) {
      setDetails(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setDetails(null);
    setError(null);
    void getOpsIncident(config, incidentCode).then(
      (next) => {
        if (!cancelled) setDetails(next);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [config, incidentCode]);

  return { details, error };
}

function Header({ config, state, width }: { config: OpsConfig; state: LoadState; width: number }) {
  const apiLabel = config.apiUrl.replace(/^https?:\/\//, "");
  const status = state.tag === "ready" ? `${state.overview.incidents.length} active  ${state.overview.signals.monitors.length + state.overview.signals.heartbeats.length} signals` : state.tag;
  const right = state.tag === "ready" ? `refreshed ${shortTime(state.refreshedAt.toISOString())}` : "r refresh";
  const midWidth = Math.max(10, width - 18 - right.length);
  return (
    <box height={2} flexDirection="column">
      <text fg={colors.text}>{trimCell(` chalk ops  ${status}  api:${apiLabel}`, midWidth) + right}</text>
      <text fg={colors.border}>{"─".repeat(Math.max(1, width))}</text>
    </box>
  );
}

function ListPane({ rows, selectedId, query, width, height }: { rows: Row[]; selectedId: string | null; query: string; width: number; height: number }) {
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === selectedId),
  );
  const scrollTop = clamp(selectedIndex - Math.floor(height / 2), 0, Math.max(0, rows.length - height));
  const visible = rows.slice(scrollTop, scrollTop + height);
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={colors.panel}>
      {visible.map((row) => {
        const selected = row.id === selectedId;
        return (
          <box key={row.id} height={1} backgroundColor={selected ? colors.panelSoft : undefined}>
            <text fg={rowFg(row, selected)}>{rowText(row, width)}</text>
          </box>
        );
      })}
      {Array.from({ length: Math.max(0, height - visible.length) }, (_, index) => (
        <text key={`pad-${index}`}> </text>
      ))}
      {query ? null : null}
    </box>
  );
}

function DetailPane({ row, details, error, width, height }: { row: Row | null; details: OpsIncidentDetails | null; error: string | null; width: number; height: number }) {
  const lines = detailLines(row, details, error, width);
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={colors.bg}>
      {lines.slice(0, height).map((line, index) => (
        <text key={index} fg={line.fg ?? colors.text}>
          {trimCell(line.text, width)}
        </text>
      ))}
      {Array.from({ length: Math.max(0, height - lines.length) }, (_, index) => (
        <text key={`pad-${index}`}> </text>
      ))}
    </box>
  );
}

function detailLines(row: Row | null, details: OpsIncidentDetails | null, error: string | null, width: number): Array<{ text: string; fg?: string }> {
  if (!row) return [{ text: "Select an incident, signal, or maintenance window.", fg: colors.muted }];
  if (row.tag === "signal") return [{ text: "SIGNAL", fg: colors.accent }, { text: row.label }, { text: `Last seen ${relativeAge(row.at)}`, fg: colors.muted }];
  if (row.tag === "maintenance") {
    return [
      { text: "MAINTENANCE", fg: colors.accent },
      { text: row.window.title },
      { text: `${row.window.status} ${shortTime(row.window.starts_at)}-${shortTime(row.window.ends_at)}`, fg: colors.info },
      { text: row.window.summary ?? row.window.public_message ?? "No summary.", fg: colors.muted },
      { text: `components ${(row.window.component_ids ?? []).join(", ") || "none"}`, fg: colors.muted },
    ];
  }
  if (row.tag !== "incident") return [{ text: row.label, fg: colors.muted }];

  const incident = details?.incident ?? row.incident;
  const output: Array<{ text: string; fg?: string }> = [
    { text: `${incident.incident_code}  ${incident.title}`, fg: colors.accent },
    { text: `${incident.severity} · ${incident.status} · ${incident.visibility}`, fg: statusColor(incident.status === "resolved" ? "resolved" : incident.severity) },
    { text: `components ${(incident.component_ids ?? []).join(", ") || "none"}`, fg: colors.muted },
    { text: `updated ${relativeAge(incident.last_seen_at ?? incident.updated_at ?? incident.created_at)} · first seen ${shortTime(incident.first_seen_at)}`, fg: colors.muted },
    { text: " " },
    { text: "SUMMARY", fg: colors.accent },
    ...wrapText(incident.summary ?? incident.public_message ?? "No summary recorded.", Math.max(20, width)).map((text) => ({ text, fg: colors.text })),
    { text: " " },
    { text: "TIMELINE", fg: colors.accent },
  ];

  if (error) {
    output.push({ text: error, fg: colors.bad });
  } else if (!details) {
    output.push({ text: "Loading timeline…", fg: colors.muted });
  } else if (details.events.length === 0) {
    output.push({ text: "No timeline events.", fg: colors.muted });
  } else {
    for (const event of details.events) {
      output.push({ text: `${shortTime(event.event_at ?? event.created_at)} ${event.event_type} ${event.visibility}`, fg: colors.info });
      for (const line of wrapText(event.message, Math.max(20, width - 2))) {
        output.push({ text: `  ${line}`, fg: colors.muted });
      }
    }
  }

  return output;
}

function wrapText(text: string, width: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function Footer({ queryMode, query, width }: { queryMode: boolean; query: string; width: number }) {
  const label = queryMode ? `/ ${query || "filter"}` : "/ filter  ↑↓/jk select  r refresh  enter detail  q quit";
  return (
    <box height={2} flexDirection="column">
      <text fg={colors.border}>{"─".repeat(Math.max(1, width))}</text>
      <text fg={queryMode ? colors.accent : colors.muted}>{trimCell(label, width)}</text>
    </box>
  );
}

function App({ config }: { config: OpsConfig }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const { state, refresh } = useOpsData(config);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [queryMode, setQueryMode] = useState(false);
  const rows = useMemo(() => buildRows(state, query), [state, query]);
  const selectable = useMemo(() => selectableRows(rows), [rows]);
  const selectedRow = rows.find((row) => row.id === selectedId) ?? selectable[0] ?? null;
  const selectedIncidentCode = selectedRow?.tag === "incident" ? selectedRow.incident.incident_code : null;
  const { details, error } = useIncidentDetails(config, selectedIncidentCode);

  useEffect(() => {
    if (!selectedId && selectable[0]) setSelectedId(selectable[0].id);
    if (selectedId && !rows.some((row) => row.id === selectedId)) setSelectedId(selectable[0]?.id ?? null);
  }, [rows, selectable, selectedId]);

  useKeyboard((event) => {
    const key = normalizeKey(event as KeyEvent);
    const currentIndex = Math.max(
      0,
      selectable.findIndex((row) => row.id === selectedRow?.id),
    );

    if (queryMode) {
      if (key === "escape" || key === "return") setQueryMode(false);
      else if (key === "backspace") setQuery((current) => current.slice(0, -1));
      else if (isTextInput(event as KeyEvent)) setQuery((current) => current + (event as KeyEvent).sequence);
      event.preventDefault();
      return;
    }

    if (key === "q" || ((event as KeyEvent).ctrl && key === "c")) {
      renderer.destroy();
      process.exit(0);
    } else if (key === "r") {
      refresh();
    } else if (key === "/" || (event as KeyEvent).sequence === "/") {
      setQueryMode(true);
    } else if (key === "escape") {
      setQuery("");
    } else if (key === "down" || key === "j") {
      setSelectedId(selectable[clamp(currentIndex + 1, 0, Math.max(0, selectable.length - 1))]?.id ?? null);
    } else if (key === "up" || key === "k") {
      setSelectedId(selectable[clamp(currentIndex - 1, 0, Math.max(0, selectable.length - 1))]?.id ?? null);
    }
    event.preventDefault();
  });

  const bodyHeight = Math.max(1, height - 4);
  const listWidth = width < 90 ? width : Math.max(36, Math.floor(width * 0.46));
  const detailWidth = width < 90 ? width : Math.max(20, width - listWidth - 1);

  if (state.tag === "error") {
    return (
      <box width={width} height={height} flexDirection="column" backgroundColor={colors.bg}>
        <Header config={config} state={state} width={width} />
        <text fg={colors.bad}>{trimCell(state.message, width)}</text>
        <text fg={colors.muted}>{trimCell("Press r to retry or q to quit.", width)}</text>
        <Footer queryMode={queryMode} query={query} width={width} />
      </box>
    );
  }

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={colors.bg}>
      <Header config={config} state={state} width={width} />
      {width < 90 ? (
        <ListPane rows={state.tag === "loading" ? [{ tag: "empty", id: "loading", label: "Loading Chalk ops…" }] : rows} selectedId={selectedRow?.id ?? null} query={query} width={width} height={bodyHeight} />
      ) : (
        <box height={bodyHeight} flexDirection="row">
          <ListPane rows={state.tag === "loading" ? [{ tag: "empty", id: "loading", label: "Loading Chalk ops…" }] : rows} selectedId={selectedRow?.id ?? null} query={query} width={listWidth} height={bodyHeight} />
          <text fg={colors.border}>│</text>
          <DetailPane row={selectedRow} details={details} error={error} width={detailWidth} height={bodyHeight} />
        </box>
      )}
      <Footer queryMode={queryMode} query={query} width={width} />
    </box>
  );
}

const config = loadOpsConfig();
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
  onDestroy: () => process.exit(0),
});

renderer.setBackgroundColor(colors.bg);
createRoot(renderer).render(<App config={config} />);
