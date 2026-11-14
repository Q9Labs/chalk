import { Link } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import type { AttendanceDTO } from "../../lib/dashboard/contracts";
import { errorMessage } from "../../lib/dashboard/client";
import { clock, duration, longDay } from "../../lib/dashboard/format";
import { videoGroup, videoState, type VideoState } from "../../lib/dashboard/recording";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { BadgeView } from "./ListParts";
import { Page, Stat } from "./Page";
import { DownloadMenu, SessionViewer, type Parts } from "./SessionViewer";
import { usePastSession, type Ids, type Page as Loaded } from "./session-reads";
import { DeleteTranscript } from "./DeleteTranscript";
import { CopyAction, ErrorPanel, Sk } from "./kit";
import { VIDEO_BADGE } from "../../lib/dashboard/lists";

const sessionLink = (ids: Ids) => `${window.location.origin}/dashboard/call/${ids.spaceId}/session/${ids.episodeId}`;

export function PastSessionPage({ spaceId, episodeId }: Ids) {
  const ids = useMemo(() => ({ spaceId, episodeId }), [spaceId, episodeId]);
  const { state, reload, actions } = usePastSession(ids);
  // A session belongs to its call, so the way back is the call, by name once it is known.
  const crumb = (
    <div className="crumb">
      <Link to="/dashboard/call/$spaceId" params={{ spaceId }}>
        <Icon name="left" size={14} />
        {state.kind === "ready" ? state.data.callName : state.kind === "loading" ? <Sk width="72px" height={12} /> : "Call"}
      </Link>
    </div>
  );
  if (state.kind === "loading") return <SessionSkeleton crumb={crumb} />;
  if (state.kind === "error")
    return (
      <Page icon="calendar" title="Session" intro="" crumb={crumb}>
        <ErrorPanel title="Couldn’t load this session" detail={errorMessage(state.error)} onRetry={reload} />
      </Page>
    );
  return (
    <SessionViewer ids={ids} page={state.data} actions={actions}>
      {(parts) => <Detail ids={ids} page={state.data} parts={parts} crumb={crumb} onDeleted={reload} />}
    </SessionViewer>
  );
}

/** The loaded page's frame with placeholders where its words and numbers go. */
function SessionSkeleton({ crumb }: { readonly crumb: ReactNode }) {
  return (
    <Page
      icon="calendar"
      title={<Sk width="180px" height={24} />}
      intro={<Sk width="240px" height={14} />}
      crumb={crumb}
      end={
        <span className="end">
          <Sk width="104px" height={36} radius="999px" />
          <Sk width="112px" height={36} radius="999px" />
        </span>
      }
    >
      <div className="card stats" aria-busy="true">
        {STAT_SHAPE.map(([icon, label]) => (
          <Stat key={label} icon={icon} label={label} value={<Sk width="56px" height={24} />}>
            <Sk width="104px" height={12} />
          </Stat>
        ))}
      </div>
      <div className="dsplit" aria-hidden="true">
        {PANEL_SHAPE.map(([icon, label]) => (
          <section key={label} className="card">
            <div className="ph">
              <Icon name={icon} size={18} />
              <h2>{label}</h2>
            </div>
            <div className="skpanel">
              <span className="sk" />
            </div>
          </section>
        ))}
      </div>
      <section className="card" aria-hidden="true">
        <div className="ph">
          <Icon name="users" size={18} />
          <h2>Who joined</h2>
        </div>
        <div className="skbody">
          {[0, 1, 2].map((index) => (
            <div key={index} className="skline">
              <Sk width="160px" height={14} />
              <Sk width="40%" height={8} radius="999px" />
            </div>
          ))}
        </div>
      </section>
    </Page>
  );
}

const STAT_SHAPE = [
  ["clock", "Duration"],
  ["users", "People"],
  ["film", "Recording"],
  ["file", "Transcript"],
] as const;
const PANEL_SHAPE = [
  ["film", "Recording"],
  ["file", "Transcript"],
] as const;

/** "Ali", "Ali and Jana", "Ali, Jana and 3 more": who came, by name, in the space a stat has. */
function names(list: readonly string[]): string {
  if (list.length === 0) return "No one joined";
  if (list.length <= 2) return list.join(" and ");
  const more = list.length - 2;
  return `${list.slice(0, 2).join(", ")} and ${more} more`;
}

/** The transcript stat in the same words as the panel beside it. */
const TRANSCRIPT_STAT: Record<Parts["transcript"], { readonly value: string; readonly sub: string }> = {
  ready: { value: "Ready", sub: "Click a line to play from it" },
  loading: { value: "Checking", sub: "Reading the transcript" },
  unreadable: { value: "Unavailable", sub: "It couldn’t be loaded" },
  preparing: { value: "Processing", sub: "You can leave this page" },
  failed: { value: "Failed", sub: "It couldn’t be made" },
  deleted: { value: "Deleted", sub: "It was deleted" },
  expired: { value: "Expired", sub: "It can’t be made now" },
  creatable: { value: "Not made", sub: "Make one from the recording" },
  none: { value: "None", sub: "Transcription was off" },
};

/** A ready transcript whose lines can't play the video, because the video isn't ready or the transcript is from another recording. */
const READ_ONLY_STAT = { value: "Ready", sub: "Ready to read" };

const VIDEO_STAT: Record<"off" | VideoState, { readonly value: string; readonly sub: string }> = {
  off: { value: "Off", sub: "Recording was off" },
  play: { value: "Ready", sub: "Ready to watch" },
  capturing: { value: "Processing", sub: "You can leave this page" },
  preparing: { value: "Processing", sub: "You can leave this page" },
  preparable: { value: "Not prepared", sub: "Prepare it to watch" },
  capture_failed: { value: "Failed", sub: "It couldn’t be made" },
  retryable: { value: "Failed", sub: "Try again to prepare it" },
  export_failed: { value: "Failed", sub: "It couldn’t be prepared" },
  expired: { value: "Expired", sub: "No longer available" },
};

type StatText = { readonly value: string; readonly sub: string };

function SessionStats({ startedAt, end, participants, video, transcript }: { readonly startedAt: string; readonly end: string; readonly participants: AttendanceDTO["participants"]; readonly video: StatText; readonly transcript: StatText }) {
  return (
    <div className="card stats" role="group" aria-label="Summary">
      <Stat
        icon="clock"
        label="Duration"
        value={
          <>
            {duration(startedAt, end).replace(" min", "")} <small>{duration(startedAt, end).includes(" h ") ? "" : "min"}</small>
          </>
        }
      >
        {clock(startedAt)} to {clock(end)}
      </Stat>
      <Stat icon="users" label="People" value={String(participants.length)}>
        <span className="ell">{names(participants.map((person) => person.name))}</span>
      </Stat>
      <Stat icon="film" label="Recording" value={video.value}>
        {video.sub}
      </Stat>
      <Stat icon="file" label="Transcript" value={transcript.value}>
        {transcript.sub}
      </Stat>
    </div>
  );
}

function RecordingSplit({ video, media, panel, onDelete }: { readonly video: VideoState | null; readonly media: ReactNode; readonly panel: ReactNode; readonly onDelete: (() => void) | null }) {
  return (
    <div className="dsplit">
      <section className="card rc" aria-labelledby="recording-title">
        <div className="ph">
          <Icon name="film" size={18} />
          <h2 id="recording-title">Recording</h2>
          {video ? <BadgeView badge={VIDEO_BADGE[videoGroup(video)]} /> : null}
        </div>
        <div className="body">{media}</div>
      </section>
      <section className="card trcard" aria-labelledby="transcript-title">
        <div className="ph">
          <Icon name="file" size={18} />
          <h2 id="transcript-title">Transcript</h2>
          {onDelete ? (
            <span className="end">
              <button type="button" className="ib dg" aria-label="Delete transcript" data-tip onClick={onDelete}>
                <Icon name="trash" />
              </button>
            </span>
          ) : null}
        </div>
        <div className="fill">{panel}</div>
      </section>
    </div>
  );
}

function NoRecording() {
  return (
    <section className="card">
      <div className="blank tall">
        <span className="tile">
          <Icon name="recOff" size={20} />
        </span>
        <b>No recording</b>
        <p>Recording was off for this session, so there’s no transcript either. Who came is still kept.</p>
      </div>
    </section>
  );
}

function Detail({ ids, page, parts, crumb, onDeleted }: { readonly ids: Ids; readonly page: Loaded; readonly parts: Parts; readonly crumb: ReactNode; readonly onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const { episode, attendance } = page.session;
  const { recording, playable, downloadableTranscript, shownTranscript, media, panel } = parts;
  const end = episode.endedAt ?? episode.startedAt;
  const video = recording ? videoState(recording) : null;
  const stat = VIDEO_STAT[video ?? "off"];
  const words = !recording ? { value: "None", sub: "Needs a recording" } : parts.transcript === "ready" && !parts.seekable ? READ_ONLY_STAT : TRANSCRIPT_STAT[parts.transcript];
  return (
    <Page
      icon="calendar"
      title={page.callName}
      intro={`${longDay(episode.startedAt)} · ${clock(episode.startedAt)} to ${clock(end)}`}
      crumb={crumb}
      end={
        <span className="end">
          <CopyAction pill text={sessionLink(ids)} toastMessage="Link copied. It opens for people signed in to this account." />
          {recording && (playable || downloadableTranscript) ? <DownloadMenu ids={ids} recording={recording} video={playable} transcript={downloadableTranscript} /> : null}
        </span>
      }
    >
      <SessionStats startedAt={episode.startedAt} end={end} participants={attendance.participants} video={stat} transcript={words} />
      {recording ? <RecordingSplit video={video} media={media} panel={panel} onDelete={shownTranscript ? () => setDeleting(true) : null} /> : <NoRecording />}
      <WhoJoined attendance={attendance} startedAt={episode.startedAt} endedAt={end} />
      {deleting && shownTranscript ? (
        <DeleteTranscript
          ids={ids}
          transcriptId={shownTranscript.id}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onDeleted();
          }}
        />
      ) : null}
    </Page>
  );
}

const TAG: Record<AttendanceDTO["participants"][number]["kind"], string | null> = { user: null, guest: "Guest", agent: "Agent" };

/** One bar for each person, first join to last leave, as the API returns it. It keeps no gaps between rejoins, so a bar can't show them. */
function WhoJoined({ attendance, startedAt, endedAt }: { readonly attendance: AttendanceDTO; readonly startedAt: string; readonly endedAt: string }) {
  const start = Date.parse(startedAt);
  const span = Math.max(Date.parse(endedAt) - start, 60_000);
  const at = (iso: string) => Math.min(Math.max((Date.parse(iso) - start) / span, 0), 1);
  return (
    <section className="card wj" aria-labelledby="who-title">
      <div className="ph">
        <Icon name="users" size={18} />
        <div>
          <h2 id="who-title">Who joined</h2>
          <div className="sub">First join to last leave. Someone who dropped and came back shows as one bar.</div>
        </div>
      </div>
      <div className="wjt">
        <div className="wjr head" aria-hidden="true">
          <div>Person</div>
          <div className="dsk">Joined</div>
          <div className="dsk">Left</div>
          <div className="dsk">Time</div>
          <div className="axis dsk">
            <span>{clock(startedAt)}</span>
            <span>{clock(new Date(start + span / 2).toISOString())}</span>
            <span>{clock(endedAt)}</span>
          </div>
        </div>
        {attendance.participants.map((person) => {
          const tag = TAG[person.kind];
          const left = person.lastLeftAt ?? endedAt;
          const from = at(person.firstJoinedAt);
          const width = Math.max(at(left) - from, 0.01);
          return (
            <div key={person.id} className="wjr">
              <div className="wjp">
                <Avatar name={person.name} size={26} />
                <span className="ell">{person.name}</span>
                {person.isYou ? <span className="pill">You</span> : null}
                {tag ? <span className="pill">{tag}</span> : null}
              </div>
              <div className="dsk num">{clock(person.firstJoinedAt)}</div>
              <div className={person.lastLeftAt ? "dsk num" : "dsk num mu"}>{person.lastLeftAt ? clock(person.lastLeftAt) : "Until the end"}</div>
              <div className="dsk num">{duration(person.firstJoinedAt, left)}</div>
              <div className="track dsk" title={`${clock(person.firstJoinedAt)} to ${clock(left)}`}>
                <i style={{ left: `${from * 100}%`, width: `${width * 100}%` }} />
              </div>
              <div className="when num">
                {clock(person.firstJoinedAt)} to {person.lastLeftAt ? clock(person.lastLeftAt) : "the end"} · {duration(person.firstJoinedAt, left)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
