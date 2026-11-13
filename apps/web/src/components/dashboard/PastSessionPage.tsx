import { Link } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import type { AttendanceDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage } from "../../lib/dashboard/client";
import { clock, duration, longDay } from "../../lib/dashboard/format";
import { videoState } from "../../lib/dashboard/recording";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { RecordingSettingsLink } from "./ListParts";
import { Page } from "./Page";
import { DownloadMenu, SessionViewer, type Parts } from "./SessionViewer";
import { usePastSession, type Ids, type Page as Loaded } from "./session-reads";
import { CopyAction, Dialog, ErrorPanel, Sk, useToast } from "./kit";

const sessionLink = (ids: Ids) => `${window.location.origin}/dashboard/call/${ids.spaceId}/session/${ids.episodeId}`;

export function PastSessionPage({ spaceId, episodeId }: Ids) {
  const ids = useMemo(() => ({ spaceId, episodeId }), [spaceId, episodeId]);
  const { state, reload, actions } = usePastSession(ids);
  // A session belongs to its call, so the way back is the call, by name once it is known.
  const crumb = (
    <div className="crumb">
      <Link className="back" to="/dashboard/call/$spaceId" params={{ spaceId }}>
        <Icon name="left" />
        {state.kind === "ready" ? state.data.callName : state.kind === "loading" ? <Sk width="72px" height={12} /> : "Call"}
      </Link>
    </div>
  );
  if (state.kind === "loading") return <SessionSkeleton crumb={crumb} />;
  if (state.kind === "error")
    return (
      <Page title="Session" intro="" crumb={crumb}>
        <ErrorPanel title="Couldn’t load this session" detail={errorMessage(state.error)} onRetry={reload} />
      </Page>
    );
  return (
    <SessionViewer ids={ids} page={state.data} actions={actions}>
      {(parts) => <Detail ids={ids} page={state.data} parts={parts} crumb={crumb} onDeleted={reload} />}
    </SessionViewer>
  );
}

/** The loaded page's frame with placeholders where its words go: the date, the times, the video and who joined. */
function SessionSkeleton({ crumb }: { readonly crumb: ReactNode }) {
  return (
    <Page title={<Sk width="220px" height={24} />} intro={<Sk width="180px" height={14} />} crumb={crumb}>
      <div className="dsplit" aria-hidden="true">
        {["Recording", "Transcript"].map((label) => (
          <section key={label} className="card">
            <div className="ph">
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

/** Transcript states worth a card of their own when there is no video beside them. */
const SOLO_TRANSCRIPT = new Set<Parts["transcript"]>(["ready", "loading", "unreadable", "preparing", "creatable", "failed"]);

function Detail({ ids, page, parts, crumb, onDeleted }: { readonly ids: Ids; readonly page: Loaded; readonly parts: Parts; readonly crumb: ReactNode; readonly onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const { episode, attendance } = page.session;
  const { recording, playable, downloadableTranscript, shownTranscript, media, panel } = parts;
  const end = episode.endedAt ?? episode.startedAt;
  // A capture that failed leaves nothing to transcribe, so its failed transcript would only repeat the note above it.
  const soloTranscript = SOLO_TRANSCRIPT.has(parts.transcript) && !(recording && parts.transcript === "failed" && videoState(recording) === "capture_failed");
  const transcriptCard = (
    <section className={playable ? "card trcard" : "card trcard solo"} aria-labelledby="transcript-title">
      <div className="ph">
        <h2 id="transcript-title">Transcript</h2>
        {shownTranscript ? (
          <span className="end">
            <button type="button" className="ib dg" aria-label="Delete transcript" data-tip onClick={() => setDeleting(true)}>
              <Icon name="trash" />
            </button>
          </span>
        ) : null}
      </div>
      <div className="fill">{panel}</div>
    </section>
  );
  return (
    <Page
      title={longDay(episode.startedAt)}
      intro={`${clock(episode.startedAt)} to ${clock(end)} · ${duration(episode.startedAt, end)}`}
      crumb={crumb}
      end={
        <span className="end">
          <CopyAction text={sessionLink(ids)} label="Copy session link" />
          {recording && (playable || downloadableTranscript) ? <DownloadMenu ids={ids} recording={recording} video={playable} transcript={downloadableTranscript} /> : null}
        </span>
      }
    >
      {playable ? (
        <div className="dsplit">
          <section className="card rc" aria-labelledby="recording-title">
            <div className="ph">
              <h2 id="recording-title">Recording</h2>
            </div>
            <div className="body">{media}</div>
          </section>
          {transcriptCard}
        </div>
      ) : recording ? (
        <>
          <section className="card snote" aria-label="Recording">
            {media}
          </section>
          {soloTranscript ? transcriptCard : null}
        </>
      ) : (
        <section className="card snote" aria-label="Recording">
          <div className="pnote" role="status">
            <div>
              <Icon name="recOff" />
              <b>Recording was off for this session</b>
              <p>Press Record in the call to keep a video and transcript next time.</p>
              <RecordingSettingsLink />
            </div>
          </div>
        </section>
      )}
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

/** Deletes only the transcript on screen. An older attempt's transcript then takes its place, so nothing goes unseen. */
function DeleteTranscript({ ids, transcriptId, onClose, onDeleted }: { readonly ids: Ids; readonly transcriptId: string; readonly onClose: () => void; readonly onDeleted: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await act("past-session", { action: "delete-transcript", ...ids, transcriptId });
      toast("Transcript deleted.", { icon: "check" });
      onDeleted();
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
      setBusy(false);
    }
  }
  return (
    <Dialog
      alert
      icon="trash"
      title="Delete this transcript?"
      description="The transcript is deleted for good. The recording and the session stay."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn out lg" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn dz lg" aria-busy={busy || undefined} disabled={busy} onClick={() => void remove()}>
            {busy ? <span className="spin" aria-hidden="true" /> : <Icon name="trash" size={16} />}
            Delete transcript
          </button>
        </>
      }
    >
      <div className="warnbox">
        <Icon name="alert" size={16} />
        <span>You can’t undo this.</span>
      </div>
    </Dialog>
  );
}

type Person = AttendanceDTO["participants"][number];

/**
 * One row for each person. The API can list the same person once for each device or rejoin, so rows for the same
 * person merge: first join to last leave, still in the call if any of their rows is.
 */
function people(participants: readonly Person[]): Person[] {
  const merged = new Map<string, Person>();
  for (const person of participants) {
    const key = person.externalId ? `id:${person.externalId}` : `name:${person.name}`;
    const known = merged.get(key);
    if (!known) {
      merged.set(key, person);
      continue;
    }
    const lastLeftAt = known.lastLeftAt === null || person.lastLeftAt === null ? null : known.lastLeftAt > person.lastLeftAt ? known.lastLeftAt : person.lastLeftAt;
    const firstJoinedAt = known.firstJoinedAt < person.firstJoinedAt ? known.firstJoinedAt : person.firstJoinedAt;
    merged.set(key, { ...known, isYou: known.isYou || person.isYou, firstJoinedAt, lastLeftAt });
  }
  return [...merged.values()].sort((a, b) => Date.parse(a.firstJoinedAt) - Date.parse(b.firstJoinedAt));
}

/** One bar for each person, first join to last leave. The API keeps no gaps between rejoins, so a bar can't show them. */
function WhoJoined({ attendance, startedAt, endedAt }: { readonly attendance: AttendanceDTO; readonly startedAt: string; readonly endedAt: string }) {
  const start = Date.parse(startedAt);
  const span = Math.max(Date.parse(endedAt) - start, 60_000);
  const at = (iso: string) => Math.min(Math.max((Date.parse(iso) - start) / span, 0), 1);
  const rows = people(attendance.participants);
  return (
    <section className="card wj" aria-labelledby="who-title">
      <div className="ph">
        <h2 id="who-title">
          Who joined <span className="cnt">{rows.length}</span>
        </h2>
      </div>
      <div className="wjt">
        <div className="wjr head" aria-hidden="true">
          <div>Person</div>
          <div className="dsk">Joined</div>
          <div className="dsk">Left</div>
          <div className="dsk">Time</div>
          <div className="axis dsk">
            <span>{clock(startedAt)}</span>
            <span>{clock(endedAt)}</span>
          </div>
        </div>
        {rows.map((person) => {
          const left = person.lastLeftAt ?? endedAt;
          const from = at(person.firstJoinedAt);
          const width = Math.max(at(left) - from, 0.01);
          return (
            <div key={person.id} className="wjr">
              <div className="wjp">
                <Avatar name={person.name} size={26} />
                <span className="ell">{person.name}</span>
                {person.isYou ? <span className="tag">You</span> : person.kind === "agent" ? <span className="tag">Agent</span> : null}
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
