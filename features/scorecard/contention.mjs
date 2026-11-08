// Public contention evidence contains counts and provenance, never resource identifiers.
export const UNAVAILABLE = "unavailable";
export const signal = (value, source) => ({ value, source });
const absent = () => signal(UNAVAILABLE, UNAVAILABLE);

// Node readouts are an optional second source. CI currently supplies API logs only.
export function contention({ lease, before, after, window, ownEpisodes = [], nodeReadouts = [] }) {
  const own = new Set(ownEpisodes);
  const foreign = window?.concat(before ?? [], after ?? []).filter((row) => row.episode_id && !own.has(row.episode_id));
  const episodes = foreign ? new Set(foreign.map((row) => row.episode_id)).size : UNAVAILABLE;
  const sessions = foreign && foreign.every((row) => row.session_id) ? new Set(foreign.map((row) => row.session_id)).size : UNAVAILABLE;
  const incarnations = nodeReadouts.map((row) => row.nodeIncarnation);
  const changes = incarnations.slice(1).filter((value, i) => value !== incarnations[i]).length;
  const steals = nodeReadouts.map((row) => row.host?.stealPercent).filter(Number.isFinite);
  const nodeForeign = nodeReadouts.some((row) => row.sessions > 0 || row.allocations > 0);
  const nodeSessions = Math.max(0, ...nodeReadouts.map((row) => row.sessions));
  const zeroEvents = window ? window.length === 0 : UNAVAILABLE;
  return {
    contended: !lease?.acquired || !!lease?.lost || !before || !after || episodes === UNAVAILABLE || episodes > 0 || !window?.some((row) => row.episode_id && own.has(row.episode_id)) || nodeForeign || changes > 0 || nodeReadouts.some((row) => row.draining),
    source: "axiom_api_logs_and_github_lease",
    lease_holder_before: lease?.previous ? signal(lease.previous.holder, "github_lease") : absent(),
    lease_acquired_at_before: lease?.previous ? signal(lease.previous.acquired_at, "github_lease") : absent(),
    lease_expires_at_before: lease?.previous ? signal(lease.previous.expires_at, "github_lease") : absent(),
    lease_acquired: signal(!!lease?.acquired, "github_lease"),
    lease_lost: signal(!!lease?.lost, "github_lease"),
    foreign_episodes_seen: signal(episodes, window ? "axiom_api_logs" : UNAVAILABLE),
    foreign_sessions_seen: nodeSessions > 0 && (sessions === UNAVAILABLE || nodeSessions > sessions) ? signal(nodeSessions, "node_readout") : signal(sessions, window ? "axiom_api_logs" : UNAVAILABLE),
    events_before: signal(before?.length ?? UNAVAILABLE, before ? "axiom_api_logs" : UNAVAILABLE),
    events_after: signal(after?.length ?? UNAVAILABLE, after ? "axiom_api_logs" : UNAVAILABLE),
    window_events: signal(window?.length ?? UNAVAILABLE, window ? "axiom_api_logs" : UNAVAILABLE),
    own_episode_events: signal(window?.filter((row) => row.episode_id && own.has(row.episode_id)).length ?? UNAVAILABLE, window ? "axiom_api_logs" : UNAVAILABLE),
    zero_chalk_sfu_events: signal(zeroEvents, window ? "axiom_api_logs" : UNAVAILABLE),
    steal_max: steals.length ? signal(Math.max(...steals), "node_readout") : absent(),
    incarnation_changes: nodeReadouts.length >= 2 ? signal(changes, "node_readout") : absent(),
    drain: nodeReadouts.length
      ? signal(
          nodeReadouts.some((row) => row.draining),
          "node_readout",
        )
      : absent(),
  };
}

export function contentionMarkdown(value) {
  if (!value) return "";
  const lines = [value.contended ? "**⚠️ CONTENDED — diagnostic only; excluded from regression baselines and trends.**" : "Lease held; no foreign Episodes observed in the API-log window."];
  lines.push(`Source: \`${value.source}\`. Foreign Episodes: ${value.foreign_episodes_seen.value}; foreign sessions: ${value.foreign_sessions_seen.value}.`);
  lines.push(`Previous lease holder: \`${value.lease_holder_before.value}\` (${value.lease_acquired_at_before.value} to ${value.lease_expires_at_before.value}).`);
  lines.push(`Node steal max: ${value.steal_max.value}; incarnation changes: ${value.incarnation_changes.value}; drain: ${value.drain.value}.`);
  lines.push(`API-log events before / during / after: ${value.events_before.value} / ${value.window_events.value} / ${value.events_after.value}. Active node state is unavailable; quiet logs do not prove an idle node.`);
  if (value.zero_chalk_sfu_events.value === true) lines.push("**Zero chalk_sfu events in the measurement window: idle node or logging gap; isolation is unverified.**");
  else if (value.own_episode_events.value === 0) lines.push("**No events attributed to this measurement's Episodes; API-log coverage is unverified.**");
  return `${lines.join("\n\n")}\n`;
}
