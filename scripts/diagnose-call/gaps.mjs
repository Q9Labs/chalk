// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { short } from "./call.mjs";
import { attr, flag, number } from "./rows.mjs";
import { unmuteGaps, unmutesOf } from "./unmute.mjs";

const SOURCE_NAMES = { client: "client (sdk.* rows)", api: "API", sfu: "SFU node", db: "database", sync: "Sync", recorder: "recorder" };
/** The node writes media stats every 10 s for a connected session, so a session that stayed up for three periods and has none lost them. */
const STATS_SPAN_MS = 30_000;
const SOURCE_ORDER = ["client", "api", "sfu", "sync", "recorder", "db"];

/**
 * What the diagnosis could not see. A gap with `blocks` could hide a failure, so a call with no bad finding and a blocking gap is
 * "not enough evidence", never "no bad call". The reading code adds its own gaps (a source not configured, a failed query, a cap); this
 * adds the gaps the rows themselves show: a source with no rows, a Participant nobody measured, a field the client never logs.
 */
export function gapsOf(call, sourceGaps, unjoined) {
  const gaps = [...sourceGaps];
  const named = new Set(sourceGaps.filter((gap) => gap.blocks).map((gap) => gap.source));
  const has = (source) => call.rows.some((row) => row.source === source);
  const add = (source, blocks, what) => gaps.push({ source, blocks, what });
  const absent = (source, what) => {
    if (!has(source) && !named.has(source)) add(source, true, what);
  };

  absent("client", "no client rows reached the Episode, so what each Participant sent and received is unknown");
  absent("api", "no API rows reached the Episode, so joins, refreshes and replacements are unknown");
  if (call.provider === "cloudflare_sfu") add("sfu", false, "the Episode used the Cloudflare media plane, whose own logs this command does not read, so no node evidence exists for it");
  else absent("sfu", `no SFU node rows reached the Episode${call.ends.some((end) => end.durable) ? " (the durable outcome of its media sessions was read, but not the node's events or media stats)" : ""}, so the node's side of every media problem is unproved`);
  absent("db", "no database rows were read, so who joined, when they left and why is unknown");
  absent("sync", "no Sync rows reached the Episode, so socket and admission problems are unknown");
  if (call.rows.some((row) => row.event === "db.recording") && !has("recorder")) add("recorder", false, "the Episode has a recording row but no recorder rows reached it, so the recorder's side is unknown");

  if (call.samples.length === 0 && has("client")) add("client", true, "no sdk.call_stats rows reached the Episode, so the media of this call was never measured");
  for (const participant of call.participants.filter((candidate) => call.database(candidate))) {
    if (call.samples.length > 0 && !call.samples.some((sample) => sample.participant === participant)) add("client", false, `Participant ${short(participant)} has no sdk.call_stats rows, so what they sent and received is unknown`);
  }
  const reporting = new Set(call.samples.map((sample) => sample.participant));
  const receiving = (participant) => call.samples.filter((sample) => sample.participant === participant && number(sample.row, "recv_bitrate_kbps") !== undefined);
  const unmeasured = [...reporting].filter((participant) => receiving(participant).length > 0 && receiving(participant).every((sample) => number(sample.row, "available_incoming_kbps") === undefined));
  if (unmeasured.length > 0) add("client", false, `bandwidth not measured for ${unmeasured.map(short).join(", ")}: the client logs no available_incoming_kbps, so a slow downlink is not ruled out`);
  if (has("sfu")) {
    for (const participant of call.participants) {
      const db = call.database(participant);
      const connection = db && attr(db, "connection_id");
      if (connection && !call.nodeEvents(connection).length) add("sfu", false, `no SFU rows name the connection of Participant ${short(participant)}, so the node's side of their media is unproved`);
    }
  }
  if (has("sfu")) gaps.push(...telemetryGaps(call));
  gaps.push(...unmuteGaps(unmutesOf(call)));
  if (unjoined > 0) add("api", false, `${unjoined} call-event rows named no Episode, connection or journey id, so they were not used`);
  return gaps;
}

/**
 * Telemetry the node should have exported and the rows do not hold: a durable outcome with no closing line, and a connected session with no media stats.
 * Both mean the export dropped rows (the `chalk.sfu.telemetry.dropped` counter says how many, and the `logs_export` gauge says whether the exporter was healthy),
 * so they are not read as a call that had no quality problem.
 */
function telemetryGaps(call) {
  const gaps = [];
  const unlogged = call.ends.filter((end) => end.durable && !end.logged);
  if (unlogged.length > 0)
    gaps.push({
      source: "sfu",
      blocks: false,
      what: `${unlogged.length} media sessions have a durable outcome but no sfu.session.closed line in the log dataset (${unlogged.map((end) => short(end.participant)).join(", ")}): the node's own closing line was lost, so check chalk.sfu.telemetry.dropped and the logs_export gauge for the node and time`,
    });
  const measured = new Set(call.rows.filter((row) => row.event.startsWith("sfu.media.")).map((row) => row.connection));
  const bare = call.ends.filter((end) => flag(end.row, "connected") !== false && number(end.row, "connect_ms") !== undefined && (number(end.row, "lifetime_ms") ?? 0) >= STATS_SPAN_MS && !measured.has(end.connection));
  if (bare.length > 0)
    gaps.push({ source: "sfu", blocks: false, what: `${bare.length} connected sessions have no sfu.media.* stats rows (${bare.map((end) => short(end.participant)).join(", ")}), so their loss, jitter and bitrate are unknown: the stats were not exported, check chalk.sfu.telemetry.dropped` });
  return gaps;
}

/** Sources with a blocking gap, in one fixed order, for the verdict line. */
export function missingSources(gaps) {
  const blocked = new Set(gaps.filter((gap) => gap.blocks).map((gap) => gap.source));
  return SOURCE_ORDER.filter((source) => blocked.has(source)).map((source) => SOURCE_NAMES[source]);
}
