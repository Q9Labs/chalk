import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@q9labsai/chalk-react";
import "../../styles/status.css";

export type StatusState = "operational" | "degraded" | "outage" | "unknown";

export type StatusSummary = {
  schema_version: number;
  generated_at: string;
  overall: StatusState;
  components: Array<{
    id: string;
    name: string;
    description: string;
    state: StatusState;
    checked_at: string | null;
    last_changed_at: string | null;
  }>;
};

type StatusFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const STATUS_STATES = new Set<StatusState>(["operational", "degraded", "outage", "unknown"]);

export function StatusPage({ fetcher = fetch, pollIntervalMs = POLL_INTERVAL_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS }: { fetcher?: StatusFetcher; pollIntervalMs?: number; requestTimeoutMs?: number }) {
  const [summary, setSummary] = useState<StatusSummary>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const requestID = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const summaryRef = useRef<StatusSummary | undefined>(undefined);

  const refresh = useCallback(async () => {
    const currentRequestID = requestID.current + 1;
    requestID.current = currentRequestID;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    let timedOut = false;
    const timeoutID = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    setError(false);
    if (summaryRef.current) setRefreshing(true);
    try {
      const response = await fetcher("/api/status", { credentials: "omit", headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`status request failed: ${response.status}`);
      const value = parseStatusSummary(await response.json());
      if (requestID.current !== currentRequestID) return;
      summaryRef.current = value;
      setSummary(value);
      setError(false);
    } catch (cause) {
      if (requestID.current !== currentRequestID) return;
      if (cause instanceof DOMException && cause.name === "AbortError" && !timedOut) return;
      setError(true);
    } finally {
      window.clearTimeout(timeoutID);
      if (activeController.current === controller) activeController.current = null;
      if (requestID.current === currentRequestID) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [fetcher, requestTimeoutMs]);

  useEffect(() => {
    let active = true;
    const runRefresh = () => {
      if (!active) return;
      void refresh();
    };
    runRefresh();
    const intervalID = window.setInterval(runRefresh, pollIntervalMs);
    return () => {
      active = false;
      window.clearInterval(intervalID);
      requestID.current += 1;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, [pollIntervalMs, refresh]);

  const unavailable = !summary && (error || !loading);
  return (
    <main className="status-page" aria-labelledby="status-title" aria-busy={loading || refreshing}>
      <header className="status-header">
        <a className="status-brand" href="/" aria-label="Chalk home">
          <Logo accessibilityLabel={null} color="currentColor" height={28} motion="orbit-burst" variant="wordmark" />
        </a>
        <p className="status-eyebrow">Public service status</p>
        <h1 id="status-title">Chalk status</h1>
        <p className="status-intro">Live service health for the Chalk platform.</p>
      </header>

      <section className="status-content" aria-live="polite">
        {loading && !summary ? (
          <p className="status-message" role="status">
            Loading current status…
          </p>
        ) : null}
        {unavailable ? (
          <div className="status-message status-message-error" role="alert">
            <h2>Status unavailable</h2>
            <p>We could not load the latest service status. Please try again.</p>
            <button className="status-refresh" type="button" onClick={() => void refresh()} disabled={refreshing} aria-busy={refreshing}>
              {refreshing ? "Trying again…" : "Try again"}
            </button>
          </div>
        ) : null}
        {summary ? (
          <>
            <section className="status-overview" aria-labelledby="status-overall-title">
              <div>
                <p className="status-eyebrow">Current state</p>
                <h2 id="status-overall-title">Overall status</h2>
                <p className="status-generated">
                  Updated <Timestamp value={summary.generated_at} />
                </p>
              </div>
              <StatusBadge state={summary.overall} />
            </section>
            {error ? (
              <p className="status-update-failed" role="status">
                The latest update failed. Showing the last known status.
              </p>
            ) : null}
            <section className="status-components" aria-labelledby="status-components-title">
              <div className="status-section-heading">
                <div>
                  <p className="status-eyebrow">Service details</p>
                  <h2 id="status-components-title">Components</h2>
                </div>
                <button className="status-refresh" type="button" onClick={() => void refresh()} disabled={refreshing} aria-busy={refreshing}>
                  {refreshing ? "Refreshing…" : "Refresh status"}
                </button>
              </div>
              <ul className="status-component-list">
                {summary.components.map((component) => (
                  <li className="status-component-card" data-state={component.state} key={component.id}>
                    <div className="status-component-heading">
                      <div>
                        <h3>{component.name}</h3>
                        <p>{component.description}</p>
                      </div>
                      <StatusBadge state={component.state} />
                    </div>
                    <dl className="status-times">
                      <div>
                        <dt>Checked</dt>
                        <dd>
                          <Timestamp value={component.checked_at} />
                        </dd>
                      </div>
                      <div>
                        <dt>Last changed</dt>
                        <dd>
                          <Timestamp value={component.last_changed_at} />
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </section>

      <footer className="status-footer">
        <p>Status updates run about every five minutes.</p>
        <a href="/">Back to Chalk</a>
      </footer>
    </main>
  );
}

function StatusBadge({ state }: { state: StatusState }) {
  return (
    <span className="status-badge" data-state={state}>
      <span aria-hidden="true" />
      {stateLabel(state)}
    </span>
  );
}

function Timestamp({ value }: { value: string | null }) {
  if (!value) return <span>Not available</span>;
  return <time dateTime={value}>{formatTimestamp(value)}</time>;
}

function stateLabel(state: StatusState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return "Not available";
  return timestamp.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function parseStatusSummary(value: unknown): StatusSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid status response");
  const source = value as Record<string, unknown>;
  if (
    typeof source.schema_version !== "number" ||
    !Number.isInteger(source.schema_version) ||
    typeof source.generated_at !== "string" ||
    !Number.isFinite(Date.parse(source.generated_at)) ||
    typeof source.overall !== "string" ||
    !STATUS_STATES.has(source.overall as StatusState) ||
    !Array.isArray(source.components)
  )
    throw new Error("invalid status response");
  const components = source.components.map((component) => parseStatusComponent(component));
  return { schema_version: source.schema_version, generated_at: source.generated_at, overall: source.overall as StatusState, components };
}

function parseStatusComponent(value: unknown): StatusSummary["components"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid status response");
  const source = value as Record<string, unknown>;
  const state = source.state;
  const checkedAt = optionalTimestamp(source.checked_at);
  const lastChangedAt = optionalTimestamp(source.last_changed_at);
  if (typeof source.id !== "string" || typeof source.name !== "string" || typeof source.description !== "string" || typeof state !== "string" || !STATUS_STATES.has(state as StatusState) || checkedAt === undefined || lastChangedAt === undefined) throw new Error("invalid status response");
  return { id: source.id, name: source.name, description: source.description, state: state as StatusState, checked_at: checkedAt, last_changed_at: lastChangedAt };
}

function optionalTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)) ? value : undefined;
}
