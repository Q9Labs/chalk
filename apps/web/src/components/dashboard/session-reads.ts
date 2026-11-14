import { useCallback, useEffect, useState } from "react";

import type { PastSessionDTO, RecordingDTO, TranscriptDTO } from "../../lib/dashboard/contracts";
import { act, failureKind, readPageTimed } from "../../lib/dashboard/client";
import { attempt, dueReads, failed, nextDue, nextRead, reread, succeeded, type Attempt, type Due } from "../../lib/dashboard/tracking";
import { Change, useLoad } from "./use-dashboard";

export type Ids = { readonly spaceId: string; readonly episodeId: string };
export type Page = { readonly session: Omit<PastSessionDTO, "recordings" | "callName">; readonly callName: string; readonly attempts: readonly Attempt[] };

/** Reads one due item. A failure lands on that item alone, except a lost session, which stops every read. */
async function readItem(ids: Ids, due: Due): Promise<(item: Attempt) => Attempt> {
  try {
    if (due.kind === "cues") {
      const { cues } = await act("past-session", { action: "transcript-document", ...ids, transcriptId: due.transcriptId });
      return (item) => ({ ...item, lines: { transcriptId: due.transcriptId, cues, read: succeeded(Date.now()) } });
    }
    if (due.kind === "transcripts") {
      const { transcripts } = await act("past-session", { action: "transcripts", ...ids, recordingId: due.id });
      return (item) => ({ ...item, recording: { ...item.recording, transcripts }, listRead: succeeded(Date.now()) });
    }
    const { data, offset } = await readPageTimed("call-metadata", { kind: "recording", spaceId: ids.spaceId, id: due.id, view: "past-session" });
    if (data.kind !== "recording") return (item) => item;
    // The server lists the recording's transcripts in the same read when it can, which also answers the list. When it
    // can't, the list may have missed a transcript made since, so it is read on its own next.
    const listed = data.recording.transcripts !== undefined;
    return (item) => ({ ...item, recording: { ...item.recording, ...data.recording }, offset: offset ?? item.offset, read: succeeded(Date.now()), listRead: listed ? succeeded(Date.now()) : { ...item.listRead, stale: true } });
  } catch (error) {
    const kind = failureKind(error);
    if (kind === "sign-in") throw error;
    const at = Date.now();
    if (due.kind === "cues") return (item) => ({ ...item, lines: { transcriptId: due.transcriptId, cues: null, read: failed(item.lines?.transcriptId === due.transcriptId ? item.lines.read : succeeded(at), kind, error, at) } });
    if (due.kind === "transcripts") return (item) => ({ ...item, listRead: failed(item.listRead, kind, error, at) });
    return (item) => ({ ...item, read: failed(item.read, kind, error, at) });
  }
}

async function loadPage(ids: Ids): Promise<Page> {
  // The session's own read carries the call's name, so no other read can fail the page.
  const { data, offset } = await readPageTimed("past-session", ids);
  const { recordings, callName, ...session } = data;
  const at = Date.now();
  const attempts = recordings.map((recording) => attempt(recording, offset ?? 0, at));
  // The shown transcript's lines load with the page rather than a tick later.
  const lines = dueReads(attempts, at).find((due) => due.kind === "cues");
  const apply = lines ? await readItem(ids, lines) : undefined;
  return { session, callName, attempts: attempts.map((item) => (apply && item.recording.id === lines?.id ? apply(item) : item)) };
}

const unchanged = new Change<Page>((page) => page);

/** Renders the page again at `at`, so a read that falls due by the clock starts the scheduler's ticks. */
function useWake(at: number | undefined) {
  const [woke, setWoke] = useState(0);
  useEffect(() => {
    if (at === undefined) return;
    const timer = window.setTimeout(() => setWoke((value) => value + 1), Math.min(Math.max(at - Date.now(), 0), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [at, woke]);
}

export type Actions = {
  readonly onRecording: (recording: RecordingDTO) => void;
  readonly onTranscript: (recordingId: string, transcript: TranscriptDTO) => void;
  readonly onRefused: (recordingId: string) => void;
};

/** One past session read, kept current while its recording or transcript is still being made. */
export function usePastSession(ids: Ids) {
  const { state, reload, update } = useLoad(() => loadPage(ids), `past:${ids.spaceId}:${ids.episodeId}`, {
    visibility: "status",
    interval: (data) => (dueReads(data.attempts, Date.now()).length ? 5000 : undefined),
    read: async (data) => {
      const due = nextRead(data.attempts, Date.now());
      if (!due) return unchanged;
      const writes = data.attempts.find((item) => item.recording.id === due.id)?.writes;
      const apply = await readItem(ids, due);
      // An answer that started before an action on the same attempt can't undo it, so that attempt is read again.
      return new Change<Page>((page) => ({ ...page, attempts: page.attempts.map((item) => (item.recording.id !== due.id ? item : item.writes === writes ? apply(item) : reread(item, due.kind))) }));
    },
  });
  useWake(state.kind === "ready" ? nextDue(state.data.attempts, Date.now()) : undefined);
  const change = useCallback((id: string, edit: (item: Attempt) => Attempt) => update((page) => ({ ...page, attempts: page.attempts.map((item) => (item.recording.id === id ? { ...edit(item), writes: item.writes + 1 } : item)) }), { refresh: false }), [update]);
  const actions: Actions = {
    // An export answer carries no transcripts, so a replacement keeps the ones already read.
    onRecording: useCallback((next: RecordingDTO) => change(next.id, (item) => ({ ...item, recording: { ...item.recording, ...next } })), [change]),
    onTranscript: useCallback((id: string, transcript: TranscriptDTO) => change(id, (item) => ({ ...item, recording: { ...item.recording, transcripts: [transcript, ...(item.recording.transcripts ?? [])] } })), [change]),
    // A refusal can mean a window closed or another request made a transcript, so the scheduler reads the recording again.
    onRefused: useCallback((id: string) => change(id, (item) => reread(item, "recording")), [change]),
  };
  return { state, reload, actions };
}
