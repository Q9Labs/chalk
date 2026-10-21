import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";

import type { CallPageDTO, RecordingDTO, CallMetadataQuery } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { clock, displayLink, duration, sessionDay } from "../../lib/dashboard/format";
import { Faces } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { useLoad } from "./AppShell";
import { RenameDialog } from "./HomePage";
import { CopyAction, ErrorPanel, Menu, MenuItem, MoreButton, Seg, Sk, SkeletonRows, useIntentKeys, usePhone, useToast } from "./kit";

const PENDING_TRANSCRIPTS = new Set(["pending", "processing", "preparing", "transcribing", "verifying", "retryable_failure"]);
const pendingRecording = (recording: RecordingDTO) => recording.transcriptionPending || ["pending", "processing"].includes(recording.status) || ["pending", "processing"].includes(recording.exportStatus);

type Admission = CallPageDTO["call"]["admission"];
type Session = CallPageDTO["episodes"][number];
const ADMISSION: readonly (readonly [Admission, string])[] = [
  ["anyone", "Anyone with the link"],
  ["knock", "Ask to join"],
];

export function CallPage({ spaceId }: { readonly spaceId: string }) {
  const pages = useRef(1);
  const metadata = useRef({ after: Date.now() + 10000, next: 0 });
  const lifecycleRefresh = useRef({ spaceId, after: 0, pending: false });
  const { state, reload, update } = useLoad(
    async () => {
      let data = await readPage("call", { spaceId });
      // Keep expanded history when a status change requires a page refresh.
      for (let page = 1; page < pages.current && data.nextCursor; page++) {
        const older = await readPage("call", { spaceId, cursor: data.nextCursor });
        data = { ...data, episodes: [...data.episodes, ...older.episodes], nextCursor: older.nextCursor };
      }
      return data;
    },
    `call:${spaceId}`,
    {
      visibility: "status",
      interval: (data) =>
        lifecycleRefresh.current.pending ||
        (!data.call.archived && data.call.admission === "knock") ||
        data.live ||
        data.episodes.some((episode) => episode.status !== "ended" || episode.recordings.some((recording) => pendingRecording(recording) || recording.transcripts?.some((transcript) => PENDING_TRANSCRIPTS.has(transcript.status)))) ||
        data.knocks.length
          ? data.knocks.length
            ? 3000
            : 5000
          : undefined,
      read: async (data) => {
        const status = await readPage("call-status", { spaceId });
        const episode = data.episodes.find((item) => item.status !== "ended");
        const changed = (data.episodes[0]?.id ?? null) !== status.latestEpisodeId || (episode?.id ?? data.live?.id) !== status.episode?.id || (episode?.status ?? (data.live ? "active" : undefined)) !== status.episode?.status;
        if (lifecycleRefresh.current.spaceId !== spaceId) lifecycleRefresh.current = { spaceId, after: 0, pending: false };
        lifecycleRefresh.current.pending = changed;
        if (changed && Date.now() >= lifecycleRefresh.current.after) {
          // Charge failed attempts too. Recheck on later ticks so the final state is fetched.
          lifecycleRefresh.current.after = Date.now() + 30000;
          const fresh = await readPage("call", { spaceId });
          // Refresh only the newest page (at most 40 engine reads), not expanded history.
          // Older ended sessions remain snapshots until an explicit page refresh.
          const older = pages.current > 1 ? data.episodes.filter((item) => item.status === "ended" && !fresh.episodes.some((current) => current.id === item.id)) : [];
          lifecycleRefresh.current.pending = false;
          return { ...fresh, episodes: [...fresh.episodes, ...older], nextCursor: pages.current > 1 ? data.nextCursor : fresh.nextCursor };
        }
        let next = { ...data, knocks: status.knocks };
        // Share one metadata request per ten seconds; recording discovery uses two reads.
        if (Date.now() < metadata.current.after) return next;
        metadata.current.after = Date.now() + 10000;
        const targets: (CallMetadataQuery | { kind: "live" })[] = data.live ? [{ kind: "live" }] : [];
        for (const session of data.episodes)
          for (const recording of session.recordings) {
            if (pendingRecording(recording)) targets.push({ kind: "recording", spaceId, id: recording.id });
            for (const transcript of recording.transcripts ?? []) if (PENDING_TRANSCRIPTS.has(transcript.status)) targets.push({ kind: "transcript", spaceId, id: transcript.id });
          }
        if (!targets.length) return next;
        const target = targets[metadata.current.next++ % targets.length];
        if (!target) return next;
        if (target.kind === "live") {
          const roster = await readPage("home-status", { spaceIds: spaceId });
          const current = roster.live[0]?.episode ?? null;
          if (current?.id !== data.live?.id) return next;
          return { ...next, live: current };
        }
        const result = await readPage("call-metadata", target);
        next = {
          ...next,
          episodes: next.episodes.map((session) => ({
            ...session,
            recordings: session.recordings.map((recording) =>
              result.kind === "recording" && recording.id === result.recording.id
                ? { ...recording, ...result.recording }
                : result.kind === "transcript"
                  ? { ...recording, transcripts: recording.transcripts?.map((transcript) => (transcript.id === result.transcript.id ? result.transcript : transcript)) }
                  : recording,
            ),
          })),
        };
        return next;
      },
    },
  );
  const [renaming, setRenaming] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const intents = useIntentKeys();
  const back = (
    <Link className="back" to="/dashboard">
      <Icon name="left" />
      Home
    </Link>
  );

  if (state.kind === "loading") return <CallSkeleton back={back} />;
  if (state.kind === "error")
    return (
      <div className="wrap">
        {back}
        <div style={{ marginTop: 24 }}>
          <ErrorPanel title="Couldn’t load this call" detail={errorMessage(state.error)} onRetry={reload} />
        </div>
      </div>
    );

  const { call, inviteUrl, episodes, live, nextCursor, knocks } = state.data;
  const current = episodes.find((episode) => episode.status === "active");
  const past = episodes.filter((episode) => episode !== current);

  async function setAdmission(admission: Admission) {
    if (admission === call.admission) return;
    try {
      const { call: changed } = await act("call", { action: "set-admission", spaceId, admission });
      update((data) => ({ ...data, call: changed }));
      toast(admission === "anyone" ? "Anyone with the link can join now" : "People now ask to join");
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }

  async function archive() {
    try {
      await act("home", { action: "archive-call", spaceId });
      toast(`Archived ${call.name}`, { icon: "trash" });
      void navigate({ to: "/dashboard" });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }

  async function answerKnock(handle: string, allow: boolean) {
    try {
      const intent = `${allow ? "approve" : "deny"}:${handle}`;
      await act("call", { action: allow ? "approve-knock" : "deny-knock", spaceId, requestHandle: handle, idempotencyKey: intents.key(intent) });
      intents.done(intent);
      update((data) => ({ ...data, knocks: data.knocks.filter((knock) => knock.handle !== handle) }));
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }

  return (
    <div className="wrap">
      {back}
      <div className="pgh">
        <h1>
          {call.name}
          <Menu label={`More actions for ${call.name}`} align="left">
            {(close) => (
              <>
                <MenuItem
                  icon="edit"
                  onSelect={() => {
                    close();
                    setRenaming(true);
                  }}
                >
                  Rename
                </MenuItem>
                <div className="msep" />
                <MenuItem
                  icon="trash"
                  danger
                  onSelect={() => {
                    close();
                    void archive();
                  }}
                >
                  Archive call
                </MenuItem>
              </>
            )}
          </Menu>
        </h1>
        <Link className="btn pri" to="/dashboard/call/$spaceId/join" params={{ spaceId }}>
          <Icon name="cam" />
          Join call
        </Link>
      </div>
      {live ? (
        <div className="liveb" role="status">
          <span className="live">
            <span className="dot" />
            Live now
          </span>
          {live.participants.length ? <Faces names={live.participants.map((person) => person.name)} size={28} /> : null}
          <span className="mu">
            {inCall(live.participants.map((person) => person.name))}
            {current ? ` It started at ${clock(current.startedAt)}.` : ""}
          </span>
        </div>
      ) : null}
      {knocks.length ? (
        <div className="list" aria-label="Asking to join" style={{ marginTop: 16 }}>
          {knocks.map((knock) => (
            <div className="orow" key={knock.handle}>
              <span>
                <b>{knock.name}</b> <span className="mu">asks to join</span>
              </span>
              <span className="ract">
                <button type="button" className="btn gh sm" onClick={() => void answerKnock(knock.handle, false)}>
                  Deny
                </button>
                <button type="button" className="btn sec sm" onClick={() => void answerKnock(knock.handle, true)}>
                  Let in
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="cset">
        <div>
          <h2>Call link</h2>
          <div className="linkrow">
            <div className="linkbox">
              <span>{displayLink(inviteUrl)}</span>
            </div>
            <CopyAction text={inviteUrl} pill />
          </div>
          <p className="help">This link never changes. Share it once and use it every time.</p>
        </div>
        <div>
          <h2 id="who-can-join">Who can join</h2>
          <Seg labelledBy="who-can-join" options={ADMISSION} value={call.admission} onChange={(value) => void setAdmission(value)} />
          <p className="help">{call.admission === "anyone" ? "People with the link join right away." : "People ask to join, and someone in the call lets them in."}</p>
        </div>
      </div>
      <div className="secth">
        <h2>Past sessions</h2>
      </div>
      {past.length === 0 ? (
        <div className="list">
          <div className="empty">
            <b>No sessions yet</b>
            <p>When someone joins with the link, each session shows here with its recording, transcript and who came.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="list">
            {past.map((episode) => (
              <SessionRow key={episode.id} spaceId={spaceId} episode={episode} />
            ))}
          </div>
          {nextCursor ? (
            <MoreButton
              label="Show older sessions"
              cursor={nextCursor}
              load={(cursor) => readPage("call", { spaceId, cursor })}
              onLoaded={(page) => {
                pages.current++;
                update((data) => ({ ...data, episodes: [...data.episodes, ...page.episodes], nextCursor: page.nextCursor }), { refresh: false });
              }}
            />
          ) : null}
        </>
      )}
      {renaming ? <RenameDialog call={call} page="call" link={inviteUrl} onClose={() => setRenaming(false)} onRenamed={(renamed) => update((data) => ({ ...data, call: renamed }))} /> : null}
    </div>
  );
}

/** "Nora, Akash and Sofia are in the call." First names, and a count past three. */
function inCall(names: readonly string[]): string {
  const first = names.map((name) => name.split(" ")[0] ?? name);
  if (!first.length) return "Nobody is in the call right now.";
  if (first.length === 1) return `${first[0]} is in the call.`;
  const shown = first.length > 3 ? [...first.slice(0, 2), `${first.length - 2} others`] : first;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)} are in the call.`;
}

type Kept = { readonly recording: boolean; readonly transcript: "none" | "ready" | "processing" };

/** What a session kept: its newest recording, and that recording's best transcript. */
function kept(recordings: readonly RecordingDTO[]): Kept {
  const recording = recordings.find((item) => item.status === "completed") ?? recordings[0];
  if (!recording) return { recording: false, transcript: "none" };
  const transcripts = recording.transcripts ?? [];
  if (transcripts.some((item) => item.status === "completed" || item.status === "complete")) return { recording: true, transcript: "ready" };
  if (transcripts.some((item) => PENDING_TRANSCRIPTS.has(item.status))) return { recording: true, transcript: "processing" };
  return { recording: true, transcript: "none" };
}

function keptSummary({ recording, transcript }: Kept): string {
  if (!recording) return "No recording";
  if (transcript === "ready") return "Recording and transcript";
  if (transcript === "processing") return "Recording · transcript soon";
  return "Recording";
}

function SessionRow({ spaceId, episode }: { readonly spaceId: string; readonly episode: Session }) {
  const phone = usePhone();
  const day = sessionDay(episode.startedAt);
  const range = episode.endedAt ? `${clock(episode.startedAt)} to ${clock(episode.endedAt)}` : `${clock(episode.startedAt)}, ending`;
  const length = episode.endedAt ? duration(episode.startedAt, episode.endedAt) : "";
  const what = kept(episode.recordings);
  const people = `${episode.participantCount} ${episode.participantCount === 1 ? "person" : "people"}`;
  const link = <Link className="ra" to="/dashboard/call/$spaceId/session/$episodeId" params={{ spaceId, episodeId: episode.id }} aria-label={`Session ${day}, ${range}${length ? `, ${length}` : ""}, ${people}, ${what.recording ? "recorded" : "not recorded"}`} />;
  if (phone)
    return (
      <div className="row">
        {link}
        <span className="rt np">
          <b>
            {day}, {clock(episode.startedAt)}
          </b>
          <span>
            {length || "Ending"} · {keptSummary(what)}
          </span>
        </span>
        <span className="np num mu">{people}</span>
        <Icon name="right" />
      </div>
    );
  return (
    <div className="row srow">
      {link}
      <span className="np">{day}</span>
      <span className="np num mu">{range}</span>
      <span className="np num mu">{length}</span>
      <span className="np num mu">{people}</span>
      <span className="kept np">
        {what.recording ? (
          <>
            <span>
              <Icon name="film" />
              Recording
            </span>
            {what.transcript === "ready" ? (
              <span>
                <Icon name="file" />
                Transcript
              </span>
            ) : what.transcript === "processing" ? (
              <span>
                <Icon name="clock" />
                Transcript processing
              </span>
            ) : null}
          </>
        ) : (
          <span>No recording</span>
        )}
      </span>
      <Icon name="right" />
    </div>
  );
}

function CallSkeleton({ back }: { readonly back: ReactNode }) {
  return (
    <div className="wrap" aria-busy="true">
      {back}
      <div className="pgh">
        <Sk width="200px" height={32} />
        <Sk width="120px" height={40} radius="8px" />
      </div>
      <div className="cset">
        <div>
          <Sk width="40%" height={14} />
          <div style={{ height: 12 }} />
          <Sk width="100%" height={40} radius="8px" />
        </div>
        <div>
          <Sk width="40%" height={14} />
          <div style={{ height: 12 }} />
          <Sk width="70%" height={40} radius="8px" />
        </div>
      </div>
      <div className="secth">
        <Sk width="160px" height={18} />
      </div>
      <SkeletonRows count={4} />
    </div>
  );
}
