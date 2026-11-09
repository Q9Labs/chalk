// Public contention evidence contains counts and provenance, never resource identifiers.
const UNAVAILABLE = "unavailable";
export const signal = (value, source) => ({ value, source });
const absent = () => signal(UNAVAILABLE, UNAVAILABLE);

// Boundary sessions are foreign; sessions during measurement include the job's own.
export function contention({ lease, before, after, window, ownEpisodes = [], nodeBefore = [], nodeAfter = [], nodeWindow = [], unobservable = false }) {
  const own = new Set(ownEpisodes);
  const foreign = window?.concat(before ?? [], after ?? []).filter((row) => row.episode_id && !own.has(row.episode_id));
  const episodes = foreign ? new Set(foreign.map((row) => row.episode_id)).size : UNAVAILABLE;
  const sessions = foreign && foreign.every((row) => row.session_id) ? new Set(foreign.map((row) => row.session_id)).size : UNAVAILABLE;
  const nodeReadouts = [...nodeBefore, ...nodeAfter];
  const readings = [...nodeReadouts, ...nodeWindow];
  const coverage = nodeBefore.length > 0 && nodeAfter.length > 0 && nodeWindow.length > 0;
  const changes = Math.max(0, new Set(readings.map((row) => row.nodeIncarnation)).size - 1);
  const steals = readings.map((row) => row.host?.stealPercent);
  const stealKnown = coverage && steals.every(Number.isFinite);
  const drainKnown = coverage && readings.every((row) => typeof row.draining === "boolean");
  const nodeForeign = nodeReadouts.some((row) => row.sessions > 0 || row.allocations > 0);
  const nodeSessions = Math.max(0, ...nodeReadouts.map((row) => row.sessions));
  const zeroEvents = window ? window.length === 0 : UNAVAILABLE;
  const observedContention = !lease?.acquired || !!lease?.lost || episodes > 0 || nodeForeign || changes > 0 || readings.some((row) => row.draining);
  const missingEvidence = !before || !after || episodes === UNAVAILABLE || !window?.some((row) => row.episode_id && own.has(row.episode_id)) || !stealKnown || !drainKnown;
  const result = {
    contended: observedContention || (!unobservable && missingEvidence),
    source: "axiom_api_logs_and_metrics_and_github_lease",
    lease_holder_before: lease?.previous ? signal(lease.previous.holder, "github_lease") : absent(),
    lease_acquired_at_before: lease?.previous ? signal(lease.previous.acquired_at, "github_lease") : absent(),
    lease_expires_at_before: lease?.previous ? signal(lease.previous.expires_at, "github_lease") : absent(),
    lease_acquired: signal(!!lease?.acquired, "github_lease"),
    lease_lost: signal(!!lease?.lost, "github_lease"),
    foreign_episodes_seen: signal(episodes, window ? "axiom_api_logs" : UNAVAILABLE),
    foreign_sessions_seen: nodeSessions > 0 && (sessions === UNAVAILABLE || nodeSessions > sessions) ? signal(nodeSessions, "axiom_metrics") : signal(sessions, window ? "axiom_api_logs" : UNAVAILABLE),
    events_before: signal(before?.length ?? UNAVAILABLE, before ? "axiom_api_logs" : UNAVAILABLE),
    events_after: signal(after?.length ?? UNAVAILABLE, after ? "axiom_api_logs" : UNAVAILABLE),
    window_events: signal(window?.length ?? UNAVAILABLE, window ? "axiom_api_logs" : UNAVAILABLE),
    own_episode_events: signal(window?.filter((row) => row.episode_id && own.has(row.episode_id)).length ?? UNAVAILABLE, window ? "axiom_api_logs" : UNAVAILABLE),
    zero_chalk_sfu_events: signal(zeroEvents, window ? "axiom_api_logs" : UNAVAILABLE),
    steal_max: stealKnown ? signal(Math.max(...steals), "axiom_metrics") : absent(),
    incarnation_changes: coverage ? signal(changes, "axiom_metrics") : absent(),
    drain: drainKnown
      ? signal(
          readings.some((row) => row.draining),
          "axiom_metrics",
        )
      : absent(),
  };
  if (unobservable) result.unobservable = true;
  return result;
}

export function contentionMarkdown(value) {
  if (!value) return "";
  const headline = value.unobservable
    ? value.contended
      ? "**⚠️ UNOBSERVABLE AND CONTENDED — isolation could not be established; excluded from regression baselines and trends.**"
      : "**⚠️ UNOBSERVABLE — isolation could not be established; excluded from regression baselines and trends.**"
    : value.contended
      ? "**⚠️ CONTENDED — diagnostic only; excluded from regression baselines and trends.**"
      : "Lease held; no foreign Episodes observed in the API-log window.";
  const lines = [headline];
  lines.push(`Source: \`${value.source}\`. Foreign Episodes: ${value.foreign_episodes_seen.value}; foreign sessions: ${value.foreign_sessions_seen.value}.`);
  lines.push(`Previous lease holder: \`${value.lease_holder_before.value}\` (${value.lease_acquired_at_before.value} to ${value.lease_expires_at_before.value}).`);
  lines.push(`Node steal max: ${value.steal_max.value}; incarnation changes: ${value.incarnation_changes.value}; drain: ${value.drain.value}.`);
  if (value.unobservable) lines.push("Node-metrics coverage was incomplete; measured latency is diagnostic only.");
  lines.push(`API-log events before / during / after: ${value.events_before.value} / ${value.window_events.value} / ${value.events_after.value}. Active node state is unavailable; quiet logs do not prove an idle node.`);
  if (value.zero_chalk_sfu_events.value === true) lines.push("**Zero chalk_sfu events in the measurement window: idle node or logging gap; isolation is unverified.**");
  else if (value.own_episode_events.value === 0) lines.push("**No events attributed to this measurement's Episodes; API-log coverage is unverified.**");
  return `${lines.join("\n\n")}\n`;
}
