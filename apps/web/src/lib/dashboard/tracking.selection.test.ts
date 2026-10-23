import { deepStrictEqual } from "node:assert/strict";
import { it } from "vitest";

import { DashboardRequestError } from "./client";
import type { RecordingDTO } from "./contracts";
import { videoState } from "./recording";
import { attempt, dueReads, failed, nextRead, selection } from "./tracking";

const STATES = ["capturing", "rendering", "preparable", "ready", "failed"] as const;
const READS = ["readable", "terminal", "transient"] as const;
type Cell = { readonly state: (typeof STATES)[number]; readonly read: (typeof READS)[number] };
const EXPORTS = { capturing: "unavailable", rendering: "pending", preparable: "none", ready: "ready", failed: "failed" } satisfies Record<Cell["state"], RecordingDTO["exportStatus"]>;
const SHOWN = { capturing: "capturing", rendering: "preparing", preparable: "preparable", ready: "play", failed: "export_failed" } as const;
const OPTIONS = STATES.flatMap((state) => READS.map((read): Cell => ({ state, read })));
const START = Date.parse("2026-10-22T12:00:00Z");
const id = (index: number) => `attempt-${index}`;

function combinations(count: number): Cell[][] {
  let rows: Cell[][] = [[]];
  for (let index = 0; index < count; index++) rows = rows.flatMap((row) => OPTIONS.map((cell) => [...row, cell]));
  return rows;
}

const MATRIX = [2, 3].flatMap(combinations).flatMap((row) => [false, true].map((buried) => ({ row, buried })));

function tracked(cell: Cell, index: number, buried: boolean) {
  const recording: RecordingDTO = {
    id: id(index),
    status: cell.state === "ready" ? "completed" : "pending",
    sourceStatus: cell.state === "capturing" ? "pending" : "available",
    sourceExpiresAt: null,
    exportStatus: EXPORTS[cell.state],
    exportRetryable: false,
    failureMessage: null,
    transcriptionStatus: "pending",
    transcriptionExpiresAt: null,
    createdAt: new Date(START - index * 60_000).toISOString(),
    transcripts: buried ? ["failed", "deleted", "failed", "deleted", "failed", "complete"].map((status, generation) => ({ id: `${id(index)}-transcript-${generation}`, status, languages: ["en"], createdAt: new Date(START - generation * 60_000).toISOString() })) : [],
  };
  const item = attempt(recording, 0, START);
  if (cell.read === "readable") return item;
  const error = cell.read === "terminal" ? new DashboardRequestError(index % 2 ? 410 : 404, "recording_not_found") : index % 2 ? new TypeError("Network unavailable") : new DashboardRequestError(503, "service_unavailable");
  return { ...item, read: failed(item.read, cell.read, error, START) };
}

it("selects and schedules all 7,200 attempt/read/list combinations, including completed transcripts behind five failed or deleted rows", () => {
  deepStrictEqual(MATRIX.length, 7200);
  for (const { row, buried } of MATRIX) {
    const attempts = row.map((cell, index) => tracked(cell, index, buried));
    const result = selection(attempts);
    const video = result.video;
    const shown = video ? videoState(video.recording) : undefined;
    const unreadable = video?.read.failure?.kind === "terminal";
    const newerState = result.newer ? videoState(result.newer.recording) : undefined;
    const actual = {
      video: video?.recording.id,
      shown: unreadable ? "unreadable" : shown,
      newer: result.newer?.recording.id,
      prepare: unreadable ? undefined : shown === "preparable" ? video?.recording.id : newerState === "preparable" ? result.newer?.recording.id : undefined,
      download: !unreadable && shown === "play",
      transcript: result.transcript?.recording.id,
      beforeRetry: dueReads(attempts, START + 4_999).map((due) => [due.kind, due.id, due.kind === "cues" ? due.transcriptId : undefined]),
      afterRetry: dueReads(attempts, START + 5_000).map((due) => [due.kind, due.id, due.kind === "cues" ? due.transcriptId : undefined]),
      nextBeforeRetry: nextRead(attempts, START + 4_999)?.id,
      nextAfterRetry: nextRead(attempts, START + 5_000)?.id,
    };

    // The oracle uses fixture states only, independently of the production selectors and state helpers.
    const available = row.map((cell, index) => ({ ...cell, index })).filter((cell) => cell.read !== "terminal");
    const actionable = (cell: Cell) => cell.state === "preparable" || cell.state === "rendering";
    const chosen = available.find((cell) => cell.state === "ready") ?? available.find(actionable) ?? available[0];
    const newer = chosen?.state === "ready" ? available.find((cell) => cell.index < chosen.index && actionable(cell)) : undefined;
    const prepare = chosen?.state === "preparable" ? chosen : newer?.state === "preparable" ? newer : undefined;
    const beforeRetry = available.filter((cell) => cell.read === "readable");
    const expected = {
      video: id(chosen?.index ?? 0),
      shown: chosen ? SHOWN[chosen.state] : "unreadable",
      newer: newer ? id(newer.index) : undefined,
      prepare: prepare ? id(prepare.index) : undefined,
      download: chosen?.state === "ready",
      transcript: id(buried ? 0 : (available[0]?.index ?? 0)),
      beforeRetry: row.flatMap((_, index) => [...(beforeRetry.some((cell) => cell.index === index) ? [["recording", id(index), undefined]] : []), ...(buried && index === 0 ? [["cues", id(0), `${id(0)}-transcript-5`]] : [])]),
      afterRetry: row.flatMap((_, index) => [...(available.some((cell) => cell.index === index) ? [["recording", id(index), undefined]] : []), ...(buried && index === 0 ? [["cues", id(0), `${id(0)}-transcript-5`]] : [])]),
      nextBeforeRetry: buried ? id(0) : beforeRetry[0] ? id(beforeRetry[0].index) : undefined,
      nextAfterRetry: buried ? id(0) : available[0] ? id(available[0].index) : undefined,
    };
    deepStrictEqual(actual, expected, `${row.map(({ state, read }) => `${state}/${read}`).join(" > ")} / buried=${buried}`);
  }
});
