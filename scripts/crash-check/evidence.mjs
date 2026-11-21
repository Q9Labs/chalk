#!/usr/bin/env node
// The checker's read of participant_media_sessions: the durable close the media node saved. `db.participant_media_sessions`
// is emitted by this reader, never a program — it turns the Postgres row into the registry row the diagnosis reads.
//
//   node scripts/crash-check/evidence.mjs <database-url> <tenant> <episode> <run>
//
// Prints the rows for one chain run as a JSON array, in event order.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const [databaseURL, tenant, episode, run] = process.argv.slice(2);
if (!databaseURL || !tenant || !episode || !run) {
  console.error("usage: evidence.mjs <database-url> <tenant> <episode> <run>");
  process.exit(2);
}

const result = spawnSync("psql", [databaseURL, "-v", `tenant=${tenant}`, "-v", `episode=${episode}`, "-At", "-F", "\t", "-c", `select connection_id, participant_id, cause, outcome, connected, (extract(epoch from ended_at) * 1000)::bigint, lifetime_ms from participant_media_sessions where tenant_id = '${tenant}' and episode_id = '${episode}' order by connection_id`], { encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const rows = result.stdout
  .trim()
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line, index) => {
    const [connection_id, participant_id, sfu_cause, sfu_outcome, connected, ended_at_ms, lifetime_ms] = line.split("\t");
    return {
      kind: "fact",
      name: "db.participant_media_sessions",
      event_id: createHash("sha256").update(`${episode}:${connection_id}`).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5"),
      est_server_ms: Number(ended_at_ms),
      duration_ms: Number(lifetime_ms),
      tenant_id: tenant,
      episode_id: episode,
      participant_id,
      connection_id,
      sfu_cause: sfu_cause || undefined,
      sfu_outcome,
      connected: connected === "t",
      ended_at_ms: Number(ended_at_ms),
      lifetime_ms: Number(lifetime_ms),
    };
  });
console.log(JSON.stringify(rows, null, 2));
