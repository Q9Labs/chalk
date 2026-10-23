import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";

import type { AttendanceDTO, PastSessionDTO, RecordingDTO, TranscriptDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, failureKind, readPageTimed } from "../../lib/dashboard/client";
import { TRANSCRIPT, VIDEO, videoState } from "../../lib/dashboard/recording";
import { attempt, dueReads, failed, nextDue, nextRead, reread, selection, succeeded, transcriptView, type Attempt, type Due, type TranscriptView } from "../../lib/dashboard/tracking";
import { clock, duration, longDay, playbackTime } from "../../lib/dashboard/format";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { Change, useLoad } from "./AppShell";
import { ErrorPanel, Menu, MenuItem, Sk, useIntentKeys, usePhone, useToast } from "./kit";

type Ids = { readonly spaceId: string; readonly episodeId: string };
type Page = { readonly session: Omit<PastSessionDTO, "recordings" | "callName">; readonly callName: string; readonly attempts: readonly Attempt[] };

/** Reads one due item. A failure lands on that item alone, except a lost session, which stops every read. */
async function readItem(ids: Ids, due: Due): Promise<(item: Attempt) => Attempt> {
  try {
    if (due.kind === "cues") {
      const { cues } = await act("past-session", { action: "transcript-document", ...ids, transcriptId: due.transcriptId });
      return (item) => ({ ...item, lines: { transcriptId: due.transcriptId, cues, read: succeeded(Date.now()) } });
    }
    if (due.kind === "transcripts") {
      const { transcripts, nextCursor } = await act("past-session", { action: "transcripts", ...ids, recordingId: due.id });
      return (item) => ({ ...item, recording: { ...item.recording, transcripts, transcriptsNextCursor: nextCursor }, listRead: succeeded(Date.now()) });
    }
    const { data, offset } = await readPageTimed("call-metadata", { kind: "recording", spaceId: ids.spaceId, id: due.id });
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

export function PastSessionPage({ spaceId, episodeId }: Ids) {
  const ids = useMemo(() => ({ spaceId, episodeId }), [spaceId, episodeId]);
  const { state, reload, update } = useLoad(() => loadPage(ids), `past:${spaceId}:${episodeId}`, {
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
  // An export answer carries no transcripts, so a replacement keeps the ones already read.
  const onRecording = useCallback((next: RecordingDTO) => change(next.id, (item) => ({ ...item, recording: { ...item.recording, ...next } })), [change]);
  const onTranscript = useCallback((id: string, transcript: TranscriptDTO) => change(id, (item) => ({ ...item, recording: { ...item.recording, transcripts: [transcript, ...(item.recording.transcripts ?? [])] } })), [change]);
  // A refusal can mean a window closed or another request made a transcript, so the scheduler reads the recording again.
  const onRefused = useCallback((id: string) => change(id, (item) => reread(item, "recording")), [change]);
  const phone = usePhone();
  const back = (name: string | null) => (
    <Link className="back" to="/dashboard/call/$spaceId" params={{ spaceId }}>
      <Icon name="left" />
      {name ?? "Call"}
    </Link>
  );

  if (state.kind === "loading")
    return (
      <div className="wrap wide" aria-busy="true">
        {back(null)}
        <Sk width="320px" height={32} />
        <div style={{ height: 10 }} />
        <Sk width="240px" height={14} />
        <div className="sgrid">
          <div>
            <Sk width="100%" height={360} radius="10px" />
          </div>
          {phone ? null : <Sk width="100%" height={360} radius="10px" />}
        </div>
      </div>
    );
  if (state.kind === "error")
    return (
      <div className="wrap wide">
        {back(null)}
        <div style={{ marginTop: 24 }}>
          <ErrorPanel title="Couldn’t load this session" detail={errorMessage(state.error)} onRetry={reload} />
        </div>
      </div>
    );
  const { video, newer, transcript } = selection(state.data.attempts);
  // Only a different video resets playback; transcript selection resets its own panel below.
  return <Session key={video?.recording.id ?? "none"} ids={ids} back={back(state.data.callName)} session={state.data.session} item={video} transcribed={transcript} newer={newer?.recording} onRecording={onRecording} onTranscript={onTranscript} onRefused={onRefused} />;
}

function Session({
  ids,
  back,
  session,
  item,
  transcribed,
  newer,
  onRecording,
  onTranscript,
  onRefused,
}: {
  readonly ids: Ids;
  readonly back: ReactNode;
  readonly session: Page["session"];
  readonly item: Attempt | undefined;
  readonly transcribed: Attempt | undefined;
  readonly newer: RecordingDTO | undefined;
  readonly onRecording: (recording: RecordingDTO) => void;
  readonly onTranscript: (recordingId: string, transcript: TranscriptDTO) => void;
  readonly onRefused: (recordingId: string) => void;
}) {
  const phone = usePhone();
  const { episode, attendance } = session;
  const recording = item?.recording;
  const transcript: TranscriptView = transcribed ? transcriptView(transcribed) : { kind: "none" };
  const intents = useIntentKeys();
  const toast = useToast();
  const [time, setTime] = useState(0);
  const seek = useRef<(seconds: number) => void>(() => {});
  const [exporting, setExporting] = useState(false);
  const end = episode.endedAt ?? episode.startedAt;
  const people = attendance.participants.length;

  const head = (
    <>
      {back}
      <div className="pgh">
        <h1>Session on {longDay(episode.startedAt)}</h1>
        {recording && (videoState(recording) === "play" || transcript.kind === "ready") ? <DownloadMenu ids={ids} recording={recording} video={videoState(recording) === "play"} transcript={transcript.kind === "ready" ? transcript.transcript : null} /> : null}
        <span className="meta">
          {clock(episode.startedAt)} to {clock(end)} · {duration(episode.startedAt, end)} · {people} {people === 1 ? "person" : "people"}
        </span>
      </div>
    </>
  );
  const who = <WhoCame attendance={attendance} endedAt={end} />;

  if (!recording)
    return (
      <div className="wrap wide">
        {head}
        <div className="sgrid slim">
          <div className="pnote">
            <div>
              <Icon name="recOff" />
              <b>No recording</b>
              <p>Recording was off for this session, so there’s no transcript either. Who came is still kept.</p>
            </div>
          </div>
          <div className="side2">{who}</div>
        </div>
      </div>
    );

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
  const unreadable = item?.read.failure?.kind === "terminal" ? item.read.failure.message : null;
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
              <button type="button" className="btn sec" disabled={exporting} onClick={() => void prepareRecording(newer)}>
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
        <p>{note.detail}</p>
        {note.action === "prepare" || note.action === "retry" ? (
          <button type="button" className="btn sec" disabled={exporting} onClick={() => void prepareRecording(recording)}>
            {actionLabel(note.action)}
          </button>
        ) : null}
      </div>
    </div>
  );
  async function createTranscript(target: RecordingDTO) {
    const recordingId = target.id;
    try {
      const created = await act("past-session", { action: "create-transcript", ...ids, recordingId, languages: [TRANSCRIPT_LANGUAGE], idempotencyKey: intents.key(`transcript:${recordingId}`) });
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

  if (phone)
    return (
      <div className="wrap wide">
        {head}
        <div className="sgrid">
          {media}
          {panel}
          <div className="below" style={{ marginTop: 4 }}>
            {who}
          </div>
        </div>
      </div>
    );
  return (
    <div className="wrap wide">
      {head}
      <div className="sgrid">
        <div>
          {media}
          <div className="below">{who}</div>
        </div>
        {panel}
      </div>
    </div>
  );
}

/** The engine needs a language to transcribe in. The viewer's own is the best single guess. */
const TRANSCRIPT_LANGUAGE = (typeof navigator === "undefined" ? "en" : navigator.language).split("-")[0]?.toLowerCase() || "en";
const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

function DownloadMenu({ ids, recording, video, transcript }: { readonly ids: Ids; readonly recording: RecordingDTO; readonly video: boolean; readonly transcript: TranscriptDTO | null }) {
  const toast = useToast();
  async function downloadRecording() {
    try {
      window.location.assign((await act("past-session", { action: "recording-url", ...ids, recordingId: recording.id, download: true })).url);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }
  async function downloadTranscript(transcriptId: string) {
    try {
      window.location.assign((await act("past-session", { action: "transcript-url", ...ids, transcriptId })).url);
      toast("Downloading the transcript", { icon: "dl" });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
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
                void downloadTranscript(transcript.id);
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
  if (transcript.kind === "loading") body = <div className="tempty">Loading the transcript…</div>;
  else if (transcript.kind === "failed")
    body = (
      <div style={{ padding: 14 }}>
        <ErrorPanel title={TRANSCRIPT.failed.copy} detail="The transcript isn’t available for this session." />
      </div>
    );
  else if (transcript.kind === "unreadable")
    body = (
      <div style={{ padding: 14 }}>
        <ErrorPanel title="Couldn’t load the transcript" detail={transcript.message} />
      </div>
    );
  else if (transcript.kind === "creatable")
    body = (
      <div className="tempty">
        <p>{TRANSCRIPT.creatable.copy}</p>
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
          Make a transcript in {languageName(TRANSCRIPT_LANGUAGE)}
        </button>
      </div>
    );
  else if (transcript.kind !== "ready") body = <div className="tempty">{TRANSCRIPT[transcript.kind].copy}</div>;
  else if (!lines.length) body = <div className="tempty">No lines mention “{query.trim()}”.</div>;
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
      </div>
      <div className="tlines">{body}</div>
    </section>
  );
}

const KIND_TAG: Record<AttendanceDTO["participants"][number]["kind"], string | null> = { user: null, guest: "Guest", agent: "Agent" };

/** One row per seat, first join to last leave, as the API returns it. */
function WhoCame({ attendance, endedAt }: { readonly attendance: AttendanceDTO; readonly endedAt: string }) {
  return (
    <section aria-labelledby="who-came">
      <h2 id="who-came">Who came</h2>
      <ul className="who">
        {attendance.participants.map((person) => {
          const tag = KIND_TAG[person.kind];
          return (
            <li key={person.id}>
              <Avatar name={person.name} size={28} />
              <div>
                <div className="nm">
                  <span>
                    {person.name}
                    {person.isYou ? " (you)" : ""}
                  </span>
                  {tag ? <span className="tag gst">{tag}</span> : null}
                </div>
                <small>
                  <span className="mono">
                    {clock(person.firstJoinedAt)} to {clock(person.lastLeftAt ?? endedAt)}
                  </span>
                  {person.lastLeftAt ? null : <span className="till">until the end</span>}
                </small>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
