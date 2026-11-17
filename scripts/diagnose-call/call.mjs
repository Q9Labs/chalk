// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { attr, number } from "./rows.mjs";

export const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
export const seconds = (ms) => Math.round(ms / 1000);
export const short = (hash) => (hash ?? "unknown").slice(0, 8);
/** A connection id is `<node incarnation>.<hex>`, so its tail tells two connections of one node apart. */
export const shortConnection = (connection) => (connection.length > 12 ? connection.slice(-8) : connection);

/** Rows named as proof: the ids of up to four, and how many rows there are. A step or finding cites them so a reader can open them. */
export function cite(rows) {
  const ids = rows.map((row) => row.id);
  return { ids: ids.length <= 4 ? ids : [ids[0], ids[1], ids.at(-2), ids.at(-1)], total: ids.length };
}

/**
 * The call_stats row's time is when the upload arrived and one upload carries several samples, so a sample's own
 * time is the connection's media start plus `elapsed_ms`. The start is the earliest `time - elapsed_ms` of the connection.
 */
function samplesOf(rows) {
  const stats = rows.filter((row) => row.event === "sdk.call_stats" && row.connection);
  const origin = new Map();
  for (const row of stats) {
    const start = row.time - Number(attr(row, "elapsed_ms") ?? 0);
    origin.set(row.connection, Math.min(origin.get(row.connection) ?? Infinity, start));
  }
  return stats
    .map((row) => {
      const end = origin.get(row.connection) + Number(attr(row, "elapsed_ms") ?? 0);
      return { row, participant: row.participant, connection: row.connection, end, start: end - Number(attr(row, "window_ms") ?? 0) };
    })
    .sort((a, b) => a.start - b.start);
}

/** Joins samples of one connection that follow each other into runs for which `match` holds. */
export function runsOf(samples, match) {
  const runs = [];
  for (const connection of new Set(samples.map((sample) => sample.connection))) {
    let run;
    for (const sample of samples.filter((candidate) => candidate.connection === connection)) {
      if (!match(sample.row)) {
        run = undefined;
      } else if (run && sample.start <= run.to + 2000) {
        run.to = sample.end;
        run.samples.push(sample);
      } else {
        run = { participant: sample.participant, connection, from: sample.start, to: sample.end, samples: [sample] };
        runs.push(run);
      }
    }
  }
  return runs;
}

/** What the rows of one Episode say, in the shape the rules and the timeline both read. */
export function buildCall(rows) {
  const samples = samplesOf(rows);
  const byParticipant = new Map();
  for (const row of rows) {
    if (row.participant) byParticipant.set(row.participant, [...(byParticipant.get(row.participant) ?? []), row]);
  }
  const database = (participant) => rows.find((row) => row.event === "db.participant" && row.participant === participant);
  return {
    rows,
    samples,
    participants: [...byParticipant.keys()],
    episode: rows.find((row) => row.event === "db.episode"),
    rowsOf: (participant) => byParticipant.get(participant) ?? [],
    database,
    /** SFU node events of one connection id. */
    nodeEvents: (connection) => rows.filter((row) => row.source === "sfu" && row.connection === connection),
    /** When the Participant left: the database's `left_at`, else the first SFU session close of theirs. */
    departedAt(participant) {
      const left = attr(database(participant) ?? { attrs: {} }, "left_at");
      if (left) return Date.parse(left);
      return rows.find((row) => row.event === "sfu.session.closed" && row.participant === participant)?.time;
    },
    /** The provider the rows name, which says whose media plane logs should exist. */
    provider: rows.map((row) => attr(row, "provider")).find((value) => value === "chalk_sfu" || value === "cloudflare_sfu"),
  };
}

/**
 * Which media plane the Episode got and who chose it: the database's stored binding (`selected_by`) and the API's
 * `media_plane.selected` event. Both are absent on an Episode that predates them, so an absent plane is not a gap.
 */
export function mediaPlane(call) {
  const selected = call.rows.filter((row) => row.event === "media_plane.selected");
  const proof = [call.episode, ...selected].filter((row) => row && (attr(row, "selected_by") ?? attr(row, "media_plane_selected_by")));
  const first = proof[0];
  if (!first) return undefined;
  return { selectedBy: attr(first, "selected_by") ?? attr(first, "media_plane_selected_by"), provider: attr(first, "provider") ?? attr(first, "media_plane_provider"), proof };
}

export const hiddenByViewer = (row) => number(row, "recv_hidden_videos") > 0;
