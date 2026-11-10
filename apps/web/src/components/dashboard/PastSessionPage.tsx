import { Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";

import type { AttendanceDTO } from "../../lib/dashboard/contracts";
import { errorMessage } from "../../lib/dashboard/client";
import { clock, duration, longDay } from "../../lib/dashboard/format";
import { videoGroup, videoState, type VideoState } from "../../lib/dashboard/recording";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { BadgeView, people } from "./ListParts";
import { Page, Stat } from "./Page";
import { DownloadMenu, SessionViewer, usePastSession, type Ids, type Page as Loaded, type Parts } from "./SessionViewer";
import { CopyAction, ErrorPanel, Sk } from "./kit";
import { VIDEO_BADGE } from "../../lib/dashboard/lists";

const sessionLink = (ids: Ids) => `${window.location.origin}/dashboard/call/${ids.spaceId}/session/${ids.episodeId}`;

export function PastSessionPage({ spaceId, episodeId }: Ids) {
  const ids = useMemo(() => ({ spaceId, episodeId }), [spaceId, episodeId]);
  const { state, reload, actions } = usePastSession(ids);
  const crumb = (
    <div className="crumb">
      <Link to="/dashboard/sessions">
        <Icon name="left" size={14} />
        Sessions
      </Link>
    </div>
  );
  if (state.kind === "loading")
    return (
      <Page icon="calendar" title="Session" intro="" crumb={crumb}>
        <div className="card stats" aria-busy="true">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="stat">
              <Sk width="80px" height={12} />
              <Sk width="60px" height={24} />
              <Sk width="100px" height={12} />
            </div>
          ))}
        </div>
        <div className="dsplit">
          <Sk width="100%" height={360} radius="12px" />
          <Sk width="100%" height={360} radius="12px" />
        </div>
      </Page>
    );
  if (state.kind === "error")
    return (
      <Page icon="calendar" title="Session" intro="" crumb={crumb}>
        <ErrorPanel title="Couldn’t load this session" detail={errorMessage(state.error)} onRetry={reload} />
      </Page>
    );
  return (
    <SessionViewer ids={ids} page={state.data} actions={actions}>
      {(parts) => <Detail ids={ids} page={state.data} parts={parts} crumb={crumb} />}
    </SessionViewer>
  );
}

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

function Detail({ ids, page, parts, crumb }: { readonly ids: Ids; readonly page: Loaded; readonly parts: Parts; readonly crumb: ReactNode }) {
  const { episode, attendance } = page.session;
  const { recording, playable, downloadableTranscript, media, panel } = parts;
  const end = episode.endedAt ?? episode.startedAt;
  const count = attendance.participants.length;
  const guests = attendance.participants.filter((person) => person.kind === "guest").length;
  const video = recording ? videoState(recording) : null;
  const stat = VIDEO_STAT[video ?? "off"];
  return (
    <Page
      icon="calendar"
      title={page.callName}
      intro={`${longDay(episode.startedAt)} · ${clock(episode.startedAt)} to ${clock(end)}`}
      crumb={crumb}
      end={
        <span className="end">
          <Link className="btn out" to="/dashboard/call/$spaceId" params={{ spaceId: ids.spaceId }}>
            Open call
            <Icon name="arrowR" size={16} />
          </Link>
          {recording && (playable || downloadableTranscript) ? <DownloadMenu ids={ids} recording={recording} video={playable} transcript={downloadableTranscript} /> : null}
        </span>
      }
    >
      <div className="card stats" role="group" aria-label="Summary">
        <Stat
          icon="clock"
          label="Duration"
          value={
            <>
              {duration(episode.startedAt, end).replace(" min", "")} <small>{duration(episode.startedAt, end).includes(" h ") ? "" : "min"}</small>
            </>
          }
        >
          {clock(episode.startedAt)} to {clock(end)}
        </Stat>
        <Stat icon="users" label="People" value={String(count)}>
          {guests ? <span className="pill">{guests === 1 ? "1 guest" : `${guests} guests`}</span> : people(count)}
        </Stat>
        <Stat icon="film" label="Recording" value={stat.value}>
          {stat.sub}
        </Stat>
        <Stat icon="file" label="Transcript" value={downloadableTranscript ? "Ready" : "–"}>
          {recording === undefined ? "Needs a recording" : downloadableTranscript ? "Ready to read" : "Shown beside the video"}
        </Stat>
      </div>
      {recording ? (
        <div className="dsplit">
          <section className="card rc">
            <div className="ph">
              <Icon name="film" size={18} />
              <h2>Recording</h2>
              {video ? <BadgeView badge={VIDEO_BADGE[videoGroup(video)]} /> : null}
              <span className="end">
                <CopyAction pill small text={sessionLink(ids)} toastMessage="Link copied. It opens for people signed in to this account." />
              </span>
            </div>
            <div className="body">{media}</div>
          </section>
          <section className="card trcard">
            <div className="ph">
              <Icon name="file" size={18} />
              <h2>Transcript</h2>
            </div>
            <div className="fill">{panel}</div>
          </section>
        </div>
      ) : (
        <section className="card">
          <div className="blank tall">
            <span className="tile">
              <Icon name="film" size={20} />
            </span>
            <b>No recording</b>
            <p>Recording was off for this session, so there’s no transcript either. Who came is still kept.</p>
          </div>
        </section>
      )}
      <WhoJoined attendance={attendance} startedAt={episode.startedAt} endedAt={end} />
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
        <span className="end">
          <span className="pill">{people(attendance.participants.length)}</span>
        </span>
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
