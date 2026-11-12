import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";

import type { PastSessionDTO, RecordingDTO, TranscriptDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, failureKind, readPageTimed } from "../../lib/dashboard/client";
import { TRANSCRIPT, VIDEO, videoState } from "../../lib/dashboard/recording";
import { attempt, dueReads, failed, nextDue, nextRead, reread, selection, succeeded, transcriptView, type Attempt, type Due, type TranscriptView } from "../../lib/dashboard/tracking";
import { clock, playbackTime } from "../../lib/dashboard/format";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { Change, useLoad } from "./AppShell";
import { ErrorPanel, Menu, MenuItem, useIntentKeys, useToast } from "./kit";

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

/** What a session's frame draws: the video or the reason there is none, the transcript beside it, and what can be downloaded. */
/** A failure the page can't fix routes to support, with the page's link so they can find the session. */
const supportHref = (problem: string) => `mailto:support@chalkmeet.com?subject=${encodeURIComponent(problem)}&body=${encodeURIComponent(`Session: ${window.location.href}`)}`;

export type Parts = {
  readonly recording: RecordingDTO | undefined;
  readonly playable: boolean;
  readonly downloadableTranscript: TranscriptDTO | null;
  readonly transcript: TranscriptView["kind"];
  readonly media: ReactNode;
  readonly panel: ReactNode;
};

/** Only a different video resets playback, so the viewer is keyed by it; transcript selection resets its own panel. */
export function SessionViewer({ ids, page, actions, children }: { readonly ids: Ids; readonly page: Page; readonly actions: Actions; readonly children: (parts: Parts) => ReactNode }) {
  const { video, newer, transcript } = selection(page.attempts);
  return <Viewer key={video?.recording.id ?? "none"} ids={ids} item={video} transcribed={transcript} newer={newer?.recording} actions={actions} render={children} />;
}

function Viewer({ ids, item, transcribed, newer, actions, render }: { readonly ids: Ids; readonly item: Attempt | undefined; readonly transcribed: Attempt | undefined; readonly newer: RecordingDTO | undefined; readonly actions: Actions; readonly render: (parts: Parts) => ReactNode }) {
  const { onRecording, onTranscript, onRefused } = actions;
  const recording = item?.recording;
  const transcript: TranscriptView = transcribed ? transcriptView(transcribed) : { kind: "none" };
  const intents = useIntentKeys();
  const toast = useToast();
  const [time, setTime] = useState(0);
  const seek = useRef<(seconds: number) => void>(() => {});
  const [exporting, setExporting] = useState(false);

  const unreadable = item?.read.failure?.kind === "terminal" ? item.read.failure.message : null;
  const playable = recording !== undefined && !unreadable && videoState(recording) === "play";
  const downloadableTranscript = transcript.kind === "ready" ? transcript.transcript : null;
  if (!recording) return render({ recording, playable, downloadableTranscript, transcript: transcript.kind, media: null, panel: null });

  async function prepareRecording(target: RecordingDTO) {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await act("past-session", { action: "export-recording", ...ids, recordingId: target.id, idempotencyKey: intents.key(`export:${target.id}`) });
      onRecording(result.recording);
      intents.done(`export:${target.id}`);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
      onRefused(target.id);
    } finally {
      setExporting(false);
    }
  }
  const video = videoState(recording);
  const note = VIDEO[video];
  const newerState = newer ? videoState(newer) : null;
  const newerAction = newerState === null ? null : VIDEO[newerState].action;
  const actionLabel = (action: "prepare" | "retry") => (exporting ? "Preparing…" : action === "retry" ? "Try again" : "Prepare recording");
  const actionIcon = (action: "prepare" | "retry") => (exporting ? <span className="spin" aria-hidden="true" /> : <Icon name={action === "retry" ? "retry" : "film"} />);
  const media = unreadable ? (
    <div className="pnote" role="alert">
      <div>
        <Icon name="alert" />
        <b>Couldn’t load this recording</b>
        <p>{unreadable}</p>
      </div>
    </div>
  ) : video === "play" ? (
    <>
      <Player ids={ids} recording={recording} onTime={setTime} seekRef={seek} />
      {newer && newerState ? (
        <div className="pnote" role="status">
          <div>
            {newerAction ? <Icon name="film" /> : <span className="spin" aria-hidden="true" />}
            <b>{newerAction === "retry" ? "A newer recording couldn’t be prepared" : newerAction ? "A newer recording is ready to prepare" : "Preparing the newer recording"}</b>
            <p>{newerAction === "retry" ? "Try again to watch or download it here." : newerAction ? "Prepare it to watch or download it here." : "It replaces this video here when it’s ready."}</p>
            {newerAction === "prepare" || newerAction === "retry" ? (
              <button type="button" className="btn pri lg" aria-busy={exporting || undefined} disabled={exporting} onClick={() => void prepareRecording(newer)}>
                {actionIcon(newerAction)}
                {actionLabel(newerAction)}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  ) : (
    <div className="pnote" role={video === "capture_failed" || video === "retryable" || video === "export_failed" ? "alert" : "status"}>
      <div>
        {video === "capturing" || video === "preparing" ? <span className="spin" aria-hidden="true" /> : <Icon name={note.action === "prepare" ? "film" : "recOff"} />}
        <b>{note.title}</b>
        <p>{recording.failureMessage || note.detail}</p>
        {note.action === "prepare" || note.action === "retry" ? (
          <button type="button" className="btn pri lg" aria-busy={exporting || undefined} disabled={exporting} onClick={() => void prepareRecording(recording)}>
            {actionIcon(note.action)}
            {actionLabel(note.action)}
          </button>
        ) : video === "capture_failed" || video === "export_failed" ? (
          <a className="btn sec lg" href={supportHref(note.title)}>
            <Icon name="send" />
            Contact support
          </a>
        ) : null}
        {video === "preparable" ? (
          <p className="pnote-more">
            <Link to="/dashboard/developer" hash="recording-videos">
              Prepare every recording on its own
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
  async function createTranscript(target: RecordingDTO) {
    const recordingId = target.id;
    try {
      const created = await act("past-session", { action: "create-transcript", ...ids, recordingId, idempotencyKey: intents.key(`transcript:${recordingId}`) });
      intents.done(`transcript:${recordingId}`);
      onTranscript(recordingId, created.transcript);
      toast("Making the transcript. It shows here when it’s ready.", { icon: "clock" });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
      onRefused(recordingId);
    }
  }
  const target = transcribed?.recording ?? recording;
  // A transcript from another attempt doesn't follow this video, so it names its attempt and its lines don't seek.
  const panel =
    target.id === recording.id ? (
      <TranscriptPanel key={target.id} transcript={transcript} time={time} onSeek={(seconds) => seek.current(seconds)} onCreate={() => createTranscript(target)} />
    ) : (
      <TranscriptPanel key={target.id} transcript={transcript} time={-1} from={clock(target.createdAt)} onCreate={() => createTranscript(target)} />
    );
  return render({ recording, playable, downloadableTranscript, transcript: transcript.kind, media, panel });
}

export function DownloadMenu({ ids, recording, video, transcript }: { readonly ids: Ids; readonly recording: RecordingDTO; readonly video: boolean; readonly transcript: TranscriptDTO | null }) {
  const toast = useToast();
  async function downloadRecording() {
    try {
      window.location.assign((await act("past-session", { action: "recording-url", ...ids, recordingId: recording.id, download: true })).url);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }
  function downloadTranscript(transcriptId: string) {
    const query = new URLSearchParams({ ...ids, transcriptId });
    window.location.assign(`/dashboard-api/transcript-text?${query}`);
  }

  return (
    <Menu
      label="Download"
      trigger={({ open, toggle }) => (
        <button type="button" className="btn sec" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <Icon name="dl" />
          Download
          <Icon name="down" />
        </button>
      )}
    >
      {(close) => (
        <>
          {video ? (
            <MenuItem
              icon="film"
              onSelect={() => {
                close();
                void downloadRecording();
              }}
            >
              Recording (MP4)
            </MenuItem>
          ) : null}
          {transcript ? (
            <MenuItem
              icon="file"
              onSelect={() => {
                close();
                downloadTranscript(transcript.id);
              }}
            >
              Transcript (text)
            </MenuItem>
          ) : null}
        </>
      )}
    </Menu>
  );
}

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

function Player({ ids, recording, onTime, seekRef }: { readonly ids: Ids; readonly recording: RecordingDTO; readonly onTime: (seconds: number) => void; readonly seekRef: RefObject<(seconds: number) => void> }) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);

  useEffect(() => {
    let current = true;
    act("past-session", { action: "recording-url", ...ids, recordingId: recording.id, download: false }).then(
      ({ url }) => current && setSource(url),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [ids, recording.id]);

  const jump = (seconds: number) => {
    const element = video.current;
    if (!element) return;
    element.currentTime = Math.max(0, Math.min(length || element.duration || 0, seconds));
  };
  seekRef.current = jump;

  if (failed)
    return (
      <div className="pnote" role="alert">
        <div>
          <Icon name="alert" />
          <b>The recording didn’t load</b>
          <p>Reload the page to try again.</p>
        </div>
      </div>
    );

  const percent = length ? (time / length) * 100 : 0;
  function scrub(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    jump(((event.clientX - rect.left) / rect.width) * length);
  }
  function scrubKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    jump(time + (event.key === "ArrowRight" ? 5 : -5));
  }
  return (
    <div className="player" role="region" aria-label="Recording" ref={box}>
      <video
        ref={video}
        src={source ?? undefined}
        playsInline
        preload="metadata"
        muted={muted}
        onClick={() => (playing ? video.current?.pause() : void video.current?.play())}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(event) => setLength(event.currentTarget.duration)}
        onTimeUpdate={(event) => {
          setTime(event.currentTarget.currentTime);
          onTime(event.currentTarget.currentTime);
        }}
      />
      <div className="pctl">
        <button type="button" className="pb" aria-label={playing ? "Pause" : "Play"} onClick={() => (playing ? video.current?.pause() : void video.current?.play())}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <span className="ptime num">
          {playbackTime(time)} / {playbackTime(length)}
        </span>
        <div className="pscrub" role="slider" tabIndex={0} aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(length)} aria-valuenow={Math.round(time)} aria-valuetext={`${playbackTime(time)} of ${playbackTime(length)}`} onPointerDown={scrub} onKeyDown={scrubKeys}>
          <span>
            <i style={{ width: `${percent}%` }} />
            <b style={{ left: `${percent}%` }} />
          </span>
        </div>
        <button
          type="button"
          className="pb sp hide-ph"
          aria-label={`Playback speed ${speed} times`}
          onClick={() => {
            const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
            setSpeed(next);
            if (video.current) video.current.playbackRate = next;
          }}
        >
          {speed}×
        </button>
        <button type="button" className="pb hide-ph" aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={() => setMuted((value) => !value)}>
          <Icon name="vol" />
        </button>
        <button type="button" className="pb" aria-label="Full screen" onClick={() => void box.current?.requestFullscreen?.()}>
          <Icon name="max" />
        </button>
      </div>
    </div>
  );
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

function TranscriptPanel({ transcript, time, from, onSeek, onCreate }: { readonly transcript: TranscriptView; readonly time: number; readonly from?: string; readonly onSeek?: (seconds: number) => void; readonly onCreate: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const search = query.trim().toLowerCase();
  const cues = transcript.kind === "ready" ? transcript.cues : [];
  const active = cues.reduce((found, cue, index) => (cue.startMs / 1000 <= time ? index : found), -1);
  const lines = useMemo(() => cues.map((cue, index) => ({ cue, index })).filter(({ cue }) => !search || cue.text.toLowerCase().includes(search)), [cues, search]);
  const mark = useMemo(() => (search ? new RegExp(`(${search.replace(ESCAPE, "\\$&")})`, "ig") : null), [search]);

  let body;
  if (transcript.kind === "loading")
    body = (
      <div className="tempty" role="status">
        <span className="spin" aria-hidden="true" />
        Loading the transcript…
      </div>
    );
  else if (transcript.kind === "unreadable")
    body = (
      <div style={{ padding: "var(--space-3)" }}>
        <ErrorPanel title="Couldn’t load the transcript" detail={transcript.message} />
      </div>
    );
  else if (transcript.kind !== "ready") {
    const state = TRANSCRIPT[transcript.kind];
    body = (
      <div className="tempty" role={transcript.kind === "failed" ? "alert" : undefined}>
        {transcript.kind === "preparing" ? <span className="spin" aria-hidden="true" /> : <Icon name="file" />}
        <div>
          <b>{state.title}</b>
          <p>{state.detail}</p>
        </div>
        {state.action === "create" ? (
          <button
            type="button"
            className="btn sec sm"
            aria-busy={creating || undefined}
            onClick={() => {
              if (creating) return;
              setCreating(true);
              void onCreate().finally(() => setCreating(false));
            }}
          >
            <Icon name="file" />
            Make a transcript
          </button>
        ) : transcript.kind === "failed" ? (
          <a className="btn sec sm" href={supportHref(state.title)}>
            <Icon name="send" />
            Contact support
          </a>
        ) : null}
      </div>
    );
  } else if (!lines.length) body = <div className="tempty">No lines mention “{query.trim()}”.</div>;
  else
    body = lines.map(({ cue, index }) => {
      const at = playbackTime(cue.startMs / 1000);
      const speaker = cue.speaker?.name;
      const content = (
        <>
          <span className="mono num">{at}</span>
          <span>
            {speaker ? (
              <b>
                <Avatar name={speaker} size={18} />
                {speaker}
              </b>
            ) : null}
            {mark ? cue.text.split(mark).map((part: string, n: number) => (n % 2 ? <mark key={n}>{part}</mark> : part)) : cue.text}
          </span>
        </>
      );
      if (!onSeek)
        return (
          <div key={index} className="tline">
            {content}
          </div>
        );
      return (
        <button key={index} type="button" className={index === active ? "tline on" : "tline"} aria-label={`Play from ${at}${speaker ? `, ${speaker}` : ""}: ${cue.text}`} aria-current={index === active ? true : undefined} onClick={() => onSeek(cue.startMs / 1000)}>
          {content}
        </button>
      );
    });

  return (
    <section className="tpanel" aria-labelledby="transcript-heading">
      <div className="thead">
        <h2 id="transcript-heading">
          Transcript
          {search && transcript.kind === "ready" ? (
            <span role="status">
              {lines.length} {lines.length === 1 ? "line" : "lines"}
            </span>
          ) : from ? (
            <span>From the {from} recording</span>
          ) : null}
        </h2>
        {transcript.kind === "ready" ? (
          <div className="tsearch">
            <Icon name="search" />
            <label className="sr" htmlFor="transcript-search">
              Search transcript
            </label>
            <input id="transcript-search" className="inp" value={query} placeholder="Search transcript" autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
            {search ? (
              <button type="button" className="ib" aria-label="Clear search" onClick={() => setQuery("")}>
                <Icon name="x" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="tlines">{body}</div>
    </section>
  );
}
