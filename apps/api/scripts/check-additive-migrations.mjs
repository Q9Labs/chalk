#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const migrationPath = "apps/api/db/migrations";
const marker = /^--\s*chalk:removed-in\s+#\d+\s*$/;

// Keep comments separate from SQL, including inside PostgreSQL dollar-quoted bodies.
function* tokens(sql) {
  let offset = 0;
  while (offset < sql.length) {
    const rest = sql.slice(offset);
    const token = /^(--[^\n]*|[Ee]'(?:''|\\.|[^'\\])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|\$[A-Za-z_0-9]*\$|[A-Za-z_][\w$]*|\s+|.)/.exec(rest)[0];
    if (rest.startsWith("/*")) {
      let depth = 1;
      offset += 2;
      while (offset < sql.length && depth > 0) {
        if (sql.startsWith("/*", offset)) {
          depth++;
          offset += 2;
        } else if (sql.startsWith("*/", offset)) {
          depth--;
          offset += 2;
        } else offset++;
      }
      continue;
    }
    const start = offset;
    offset += token.length;
    if (token.startsWith("--") && /\S/.test(sql.slice(sql.lastIndexOf("\n", start - 1) + 1, start))) continue;
    if (/^\$[A-Za-z_0-9]*\$$/.test(token)) {
      const end = sql.indexOf(token, offset);
      if (end < 0) throw new Error("Unclosed dollar quote");
      // Body comments cannot act as goose directives or authorize the outer migration.
      for (const inner of tokens(sql.slice(offset, end))) {
        if (!inner.startsWith("--")) yield inner;
      }
      offset = end + token.length;
    } else if (token.startsWith("'") || /^[Ee]'/.test(token)) {
      yield "literal";
    } else if (token.startsWith('"')) {
      yield "identifier";
    } else if (!/^\s+$/.test(token)) {
      yield token;
    }
  }
}

function check(sql) {
  let section = "";
  let approved = false;
  let sawUp = false;
  const up = [];
  for (const token of tokens(sql)) {
    if (/^--\s*\+goose\s+Up\s*$/i.test(token)) {
      section = "up";
      sawUp = true;
    } else if (/^--\s*\+goose\s+Down\s*$/i.test(token)) {
      section = "down";
    } else if (section === "up") {
      if (marker.test(token)) approved = true;
      if (!token.startsWith("--")) up.push(token);
    }
  }
  if (!sawUp) return "Missing goose Up section";
  const sqlUp = up.join(" ").toUpperCase();
  const destructive = /\b(?:DROP|RENAME)\b|\bALTER\s+(?:COLUMN\s+)?\w+\s+(?:SET\s+DATA\s+)?TYPE\b/.exec(sqlUp);
  // This exact replacement only loosens the existing participant CHECK. No other
  // statement or constraint can enter through this exception.
  const widensRecordingParticipants = sqlUp === "ALTER TABLE RECORDING_CAPACITY DROP CONSTRAINT RECORDING_CAPACITY_RESERVED_PARTICIPANTS_CHECK1 ; ALTER TABLE RECORDING_CAPACITY ADD CONSTRAINT RECORDING_CAPACITY_RESERVED_PARTICIPANTS_CHECK1 CHECK ( RESERVED_PARTICIPANTS BETWEEN 0 AND 2 0 0 ) ;";
  // This exact atomic replacement only widens duration CHECKs; all other facts stay enforced.
  const recordingDurationWidening =
    "alter table recording_reservations drop constraint recording_reservations_max_duration_seconds_check1;\nalter table recording_reservations add constraint recording_reservations_max_duration_seconds_check1 check (max_duration_seconds between 1 and 14400);\nalter table recording_render_object_allocations drop constraint recording_render_allocations_purpose_facts_check;\nalter table recording_render_object_allocations add constraint recording_render_allocations_purpose_facts_check check (\n        (purpose = 'recording_video' and (state = 'reserved' or (expected_content_type = 'video/mp4' and expected_byte_size <= 34359738368 and expected_duration_millis between 1 and 14400000)))\n        or (purpose = 'transcription_manifest' and (state = 'reserved' or (expected_content_type = 'application/json' and expected_byte_size <= 1048576 and expected_duration_millis is null)))\n        or (purpose = 'transcription_audio' and (state = 'reserved' or (expected_content_type = 'audio/flac' and expected_byte_size <= 524288000 and expected_duration_millis between 1 and 900000)))\n);\n";
  const widensRecordingDuration = sqlUp === [...tokens(recordingDurationWidening)].join(" ").toUpperCase() && sql.includes(recordingDurationWidening.trim());
  if (destructive && !approved && !widensRecordingParticipants && !widensRecordingDuration) {
    return `${destructive[0]} in Up needs -- chalk:removed-in #<PR> naming the merged pull request that stopped using the object`;
  }
}

try {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const baseRef = process.env.GATE_BASE_REF ?? "origin/master";
  const shallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
  const baseExists = spawnSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: root }).status === 0;
  if (baseRef === "origin/master" && (shallow || !baseExists)) {
    git(["fetch", "--no-tags", ...(shallow ? ["--unshallow"] : []), "origin", "master:refs/remotes/origin/master"]);
  }
  const base = git(["merge-base", baseRef, "HEAD"]).trim();
  const files = git(["diff", "--name-only", "--diff-filter=A", "--no-renames", "-z", base, "--", migrationPath])
    .split("\0")
    .filter((file) => file.endsWith(".sql"));
  let failures = 0;
  for (const file of files) {
    const failure = check(readFileSync(`${root}/${file}`, "utf8"));
    if (failure) {
      console.error(`${file}: ${failure}`);
      failures++;
    }
  }
  console.log(`Additive migrations: checked ${files.length} new migration(s), ${failures} failure(s).`);
  process.exitCode = failures ? 1 : 0;
} catch (error) {
  console.error(`Additive migration check failed: ${error.message}`);
  process.exitCode = 1;
}
