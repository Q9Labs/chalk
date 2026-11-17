// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
export const SOURCES = ["client", "api", "sync", "sfu", "recorder", "db"];

/**
 * Reaches every row of a call by id and by nothing else. A row belongs to the Episode when it names the Episode, or
 * names a connection id or a journey or trace id that a row of the Episode names. Time never decides.
 * The result keeps the rows of the Episode in time order and counts, for each source, how each row was reached.
 * A row that names no id at all is `unjoined`: the call may need it, but nothing links it.
 */
export function joinByIds(episodeId, rows) {
  const connections = new Set();
  const links = new Set();
  const via = new Map();
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (via.has(row)) continue;
      const reached = row.episode === episodeId ? "episode" : row.connection && connections.has(row.connection) ? "connection" : (row.journey && links.has(row.journey)) || (row.trace && links.has(row.trace)) ? "journey" : undefined;
      if (!reached) continue;
      via.set(row, reached);
      grew = true;
      if (row.connection) connections.add(row.connection);
      if (row.journey) links.add(row.journey);
      if (row.trace) links.add(row.trace);
    }
  }

  const stats = Object.fromEntries(SOURCES.map((source) => [source, { rows: 0, episode: 0, connection: 0, journey: 0, unjoined: 0 }]));
  const joined = [];
  const unjoined = [];
  for (const row of rows) {
    const reached = via.get(row);
    if (reached) {
      stats[row.source][reached] += 1;
      stats[row.source].rows += 1;
      joined.push(row);
    } else if (!row.episode && !row.connection && !row.journey && !row.trace) {
      stats[row.source].unjoined += 1;
      stats[row.source].rows += 1;
      unjoined.push(row);
    }
    // A row that names another Episode, connection or journey is another call's row, not a missing link.
  }
  joined.sort((a, b) => a.time - b.time);
  inferParticipants(joined);
  return { joined, unjoined, stats };
}

/**
 * A row that names a connection or a journey but no Participant (a media replacement, a lease line) takes the Participant
 * that other rows of the same connection or journey name, when exactly one Participant does. This is an id join, not a time join.
 */
function inferParticipants(rows) {
  const owners = (key) => {
    const found = new Map();
    for (const row of rows) {
      if (row.participant && row[key]) found.set(row[key], new Set([...(found.get(row[key]) ?? []), row.participant]));
    }
    return found;
  };
  const byKey = { connection: owners("connection"), journey: owners("journey") };
  for (const row of rows) {
    if (row.participant) continue;
    for (const key of ["connection", "journey"]) {
      const candidates = row[key] ? byKey[key].get(row[key]) : undefined;
      if (candidates?.size === 1) row.participant = [...candidates][0];
    }
  }
}

/** Share of a source's rows that were reached by id, 1 when the source has none. */
export function joinedShare(stat) {
  return stat.rows === 0 ? 1 : (stat.episode + stat.connection + stat.journey) / stat.rows;
}

/** Fails loudly when any row of a call has no id that reaches it. */
export function assertEveryRowJoined(result) {
  const lost = result.unjoined.map((row) => `${row.source}:${row.event}`);
  if (lost.length > 0) throw new Error(`rows with no id that reaches the Episode: ${lost.join(", ")}`);
}
