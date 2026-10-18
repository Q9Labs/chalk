import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";

import type { AttendanceDTO, CueDTO, PastSessionDTO, RecordingDTO, TranscriptDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, intentKey, readPage } from "../../lib/dashboard/client";
import { clock, duration, longDay, playbackTime } from "../../lib/dashboard/format";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { useLoad } from "./AppShell";
import { ErrorPanel, Menu, MenuItem, Sk, useIntentKeys, usePhone, useToast } from "./kit";

type Ids = { readonly spaceId: string; readonly episodeId: string };
type Transcript = { readonly kind: "loading" } | { readonly kind: "none" } | { readonly kind: "processing" } | { readonly kind: "failed" } | { readonly kind: "ready"; readonly transcript: TranscriptDTO; readonly cues: readonly CueDTO[] };

async function loadSession({ spaceId, episodeId }: Ids) {
  const [session, call] = await Promise.all([readPage("past-session", { spaceId, episodeId }), readPage("call", { spaceId })]);
  return { session, callName: call.call.name };
}

export function PastSessionPage({ spaceId, episodeId }: Ids) {
  const ids = useMemo(() => ({ spaceId, episodeId }), [spaceId, episodeId]);
  const { state, reload } = useLoad(() => loadSession(ids), `past:${spaceId}:${episodeId}`);
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
  return <Session ids={ids} back={back(state.data.callName)} session={state.data.session} />;
}

function Session({ ids, back, session }: { readonly ids: Ids; readonly back: ReactNode; readonly session: PastSessionDTO }) {
  const phone = usePhone();
  const { episode, attendance, recordings } = session;
  const recording = recordings.find((item) => item.status === "completed") ?? recordings[0];
  const [transcript, setTranscript] = useTranscript(ids, recording);
  const intents = useIntentKeys();
  const toast = useToast();
  const [time, setTime] = useState(0);
  const seek = useRef<(seconds: number) => void>(() => {});
  const end = episode.endedAt ?? episode.startedAt;
  const people = attendance.participants.length;

  const head = (
    <>
      {back}
      <div className="pgh">
        <h1>Session on {longDay(episode.startedAt)}</h1>
        {recording?.status === "completed" ? <DownloadMenu ids={ids} recording={recording} transcript={transcript.kind === "ready" ? transcript.transcript : null} /> : null}
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

  const media =
    recording.status === "completed" ? (
      <Player ids={ids} recording={recording} onTime={setTime} seekRef={seek} />
    ) : (
      <div className="pnote" role="status">
        <div>
          <span className="spin" aria-hidden="true" />
          <b>Processing the recording</b>
          <p>The recording and transcript show here when they’re ready. You can leave this page.</p>
        </div>
      </div>
    );
  async function createTranscript(recordingId: string) {
    try {
      await act("past-session", { action: "create-transcript", ...ids, recordingId, languages: [TRANSCRIPT_LANGUAGE], idempotencyKey: intents.key(`transcript:${recordingId}`) });
      intents.done(`transcript:${recordingId}`);
      setTranscript({ kind: "processing" });
      toast("Making the transcript. It shows here when it’s ready.", { icon: "clock" });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }
  const panel = <TranscriptPanel transcript={recording.status === "completed" ? transcript : { kind: "processing" }} time={time} onSeek={(seconds) => seek.current(seconds)} onCreate={() => createTranscript(recording.id)} />;

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

function useTranscript(ids: Ids, recording: RecordingDTO | undefined): readonly [Transcript, (next: Transcript) => void] {
  const [state, setState] = useState<Transcript>({ kind: "loading" });
  const recordingId = recording?.status === "completed" ? recording.id : null;
  useEffect(() => {
    if (!recordingId) return;
    let current = true;
    (async (): Promise<Transcript> => {
      const { transcripts } = await act("past-session", { action: "transcripts", ...ids, recordingId });
      const transcript = transcripts.find((item) => item.status === "completed") ?? transcripts[0];
      if (!transcript) return { kind: "none" };
      if (transcript.status === "failed") return { kind: "failed" };
      if (transcript.status !== "completed") return { kind: "processing" };
      const { cues } = await act("past-session", { action: "transcript-document", ...ids, transcriptId: transcript.id });
      return { kind: "ready", transcript, cues };
    })().then(
      (next) => current && setState(next),
      () => current && setState({ kind: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [ids, recordingId]);
  return [state, setState];
}

function DownloadMenu({ ids, recording, transcript }: { readonly ids: Ids; readonly recording: RecordingDTO; readonly transcript: TranscriptDTO | null }) {
  const [preparing, setPreparing] = useState(recording.exportStatus === "processing");
  const toast = useToast();
  async function downloadRecording() {
    try {
      if (recording.exportStatus === "completed") {
        window.location.assign((await act("past-session", { action: "recording-url", ...ids, recordingId: recording.id, download: true })).url);
        return;
      }
      if (preparing) return;
      await act("past-session", { action: "export-recording", ...ids, recordingId: recording.id, idempotencyKey: intentKey() });
      setPreparing(true);
      toast("Preparing the MP4. Come back to download it when it’s ready.", { icon: "clock" });
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
          <MenuItem
            icon={preparing ? "clock" : "film"}
            onSelect={() => {
              close();
              void downloadRecording();
            }}
          >
            {preparing ? "Preparing the MP4…" : "Recording (MP4)"}
          </MenuItem>
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

function TranscriptPanel({ transcript, time, onSeek, onCreate }: { readonly transcript: Transcript; readonly time: number; readonly onSeek: (seconds: number) => void; readonly onCreate: () => Promise<void> }) {
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
        <ErrorPanel title="The transcript couldn’t be made" detail="The recording is fine. The transcript isn’t available for this session." />
      </div>
    );
  else if (transcript.kind === "processing") body = <div className="tempty">The transcript follows the recording.</div>;
  else if (transcript.kind === "none")
    body = (
      <div className="tempty">
        <p>There’s no transcript for this recording.</p>
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
  else if (!lines.length) body = <div className="tempty">No lines mention “{query.trim()}”.</div>;
  else
    body = lines.map(({ cue, index }) => {
      const at = playbackTime(cue.startMs / 1000);
      const speaker = cue.speaker?.name;
      return (
        <button key={index} type="button" className={index === active ? "tline on" : "tline"} aria-label={`Play from ${at}${speaker ? `, ${speaker}` : ""}: ${cue.text}`} aria-current={index === active ? true : undefined} onClick={() => onSeek(cue.startMs / 1000)}>
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
