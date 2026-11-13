import { Link, useNavigate } from "@tanstack/react-router";
import { rememberJoiningCall } from "./join-call";
import { useRef, useState, type ReactNode } from "react";

import type { CallPageDTO, RecordingDTO, CallMetadataQuery, CallMetadataDTO, TranscriptDTO } from "../../lib/dashboard/contracts";
import { act, DashboardRequestError, errorMessage, readPage } from "../../lib/dashboard/client";
import type { RowModel } from "../../lib/dashboard/lists";
import { keptRecording, videoState, workingRecording } from "../../lib/dashboard/recording";
import { clock, displayLink } from "../../lib/dashboard/format";
import { Faces } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { useLoad } from "./AppShell";
import { RenameDialog } from "./HomePage";
import { AdmissionKnocks } from "./AdmissionKnocks";
import { SessionRow, SessionsHead } from "./ListParts";
import { useJumpTarget } from "./jump";
import { LanguagePicker } from "./LanguagePicker";
import { rememberLanguage, type NewCallLanguage } from "./transcript-languages";
import { CopyAction, ErrorPanel, Menu, MenuItem, MoreButton, Seg, Sk, SkeletonRows, useIntentKeys, useToast } from "./kit";

const PENDING_TRANSCRIPTS = new Set(["pending", "processing", "preparing", "transcribing", "verifying", "retryable_failure"]);

type Admission = CallPageDTO["call"]["admission"];
const ADMISSION: readonly (readonly [Admission, string])[] = [
  ["anyone", "Anyone with the link"],
  ["knock", "Ask to join"],
];

export function CallPage({ spaceId }: { readonly spaceId: string }) {
  const pendingDecisions = useRef(new Set<string>());
  const pages = useRef(1);
  const metadata = useRef({ after: Date.now() + 10000, next: 0, unlisted: new Set<string>(), unavailable: new Set<string>() });
  const lifecycleRefresh = useRef({ spaceId, after: 0, pending: false });
  const { state, reload, update } = useLoad(
    async () => {
      let data = await readPage("call", { spaceId });
      // Keep expanded history when a status change requires a page refresh.
      for (let page = 1; page < pages.current && data.nextCursor; page++) {
        const older = await readPage("call", { spaceId, cursor: data.nextCursor });
        data = { ...data, episodes: [...data.episodes, ...older.episodes], nextCursor: older.nextCursor };
      }
      metadata.current.unlisted.clear();
      metadata.current.unavailable.clear();
      return data;
    },
    `call:${spaceId}`,
    {
      visibility: "status",
      interval: (data) =>
        lifecycleRefresh.current.pending ||
        (!data.call.archived && data.call.admission === "knock") ||
        data.live ||
        data.episodes.some(
          (episode) =>
            episode.status !== "ended" ||
            episode.recordings.some(
              (recording) => workingRecording(recording) || (!metadata.current.unavailable.has(recording.id) && (recording.transcripts === undefined || metadata.current.unlisted.has(recording.id) || recording.transcripts.some((transcript) => PENDING_TRANSCRIPTS.has(transcript.status)))),
            ),
        ) ||
        data.knocks.length
          ? data.knocks.length
            ? 3000
            : 5000
          : undefined,
      read: async (data) => {
        const status = await readPage("call-status", { spaceId });
        const episode = data.episodes.find((item) => item.status !== "ended");
        const changed =
          (status.episode?.status === "active" && data.live?.id !== status.episode.id) || (data.episodes[0]?.id ?? null) !== status.latestEpisodeId || (episode?.id ?? data.live?.id) !== status.episode?.id || (episode?.status ?? (data.live ? "active" : undefined)) !== status.episode?.status;
        if (lifecycleRefresh.current.spaceId !== spaceId) lifecycleRefresh.current = { spaceId, after: 0, pending: false };
        lifecycleRefresh.current.pending = changed;
        if (changed && Date.now() >= lifecycleRefresh.current.after) {
          // Charge failed attempts too. Recheck on later ticks so the final state is fetched.
          lifecycleRefresh.current.after = Date.now() + 30000;
          const fresh = await readPage("call", { spaceId });
          // Refresh only the newest page (at most 41 engine reads including Tenant resolution), not expanded history.
          // Older ended sessions remain snapshots until an explicit page refresh.
          const older = pages.current > 1 ? data.episodes.filter((item) => item.status === "ended" && !fresh.episodes.some((current) => current.id === item.id)) : [];
          lifecycleRefresh.current.pending = false;
          return { ...fresh, episodes: [...fresh.episodes, ...older], nextCursor: pages.current > 1 ? data.nextCursor : fresh.nextCursor };
        }
        let next = { ...data, knocks: status.knocks };
        // Share one metadata request per ten seconds; recording discovery uses two reads.
        if (Date.now() < metadata.current.after) return next;
        metadata.current.after = Date.now() + 10000;
        const targets: (CallMetadataQuery | { kind: "live" } | { kind: "transcripts"; spaceId: string; episodeId: string; id: string })[] = data.live ? [{ kind: "live" }] : [];
        for (const session of data.episodes)
          for (const recording of session.recordings) {
            if (workingRecording(recording)) targets.push({ kind: "recording", spaceId, id: recording.id });
            if (metadata.current.unavailable.has(recording.id)) continue;
            if (recording.transcripts === undefined || metadata.current.unlisted.has(recording.id)) targets.push({ kind: "transcripts", spaceId, episodeId: session.id, id: recording.id });
            else for (const transcript of recording.transcripts) if (PENDING_TRANSCRIPTS.has(transcript.status)) targets.push({ kind: "transcript", spaceId, id: transcript.id });
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
        if (target.kind === "transcripts") {
          let result: { transcripts: TranscriptDTO[] };
          try {
            result = await act("past-session", { action: "transcripts", spaceId, episodeId: target.episodeId, recordingId: target.id, view: "call" });
          } catch (error) {
            if (!(error instanceof DashboardRequestError) || ![403, 404, 410].includes(error.status)) throw error;
            metadata.current.unlisted.delete(target.id);
            metadata.current.unavailable.add(target.id);
            return next;
          }
          metadata.current.unlisted.delete(target.id);
          return {
            ...next,
            episodes: next.episodes.map((session) => ({ ...session, recordings: session.recordings.map((recording) => (recording.id === target.id ? { ...recording, transcripts: result.transcripts } : recording)) })),
          };
        }
        let result: CallMetadataDTO;
        try {
          result = await readPage("call-metadata", target);
        } catch (error) {
          // Only artifact reads can reconcile absence here. Status and page failures
          // still reach useLoad, which handles access loss, sign-in and backoff.
          if (!(error instanceof DashboardRequestError) || ![403, 404, 410].includes(error.status)) throw error;
          return {
            ...next,
            episodes: next.episodes.map((session) => ({
              ...session,
              recordings: session.recordings.filter((recording) => target.kind !== "recording" || recording.id !== target.id).map((recording) => (target.kind === "transcript" ? { ...recording, transcripts: recording.transcripts?.filter((transcript) => transcript.id !== target.id) } : recording)),
            })),
          };
        }
        if (result.kind === "recording") {
          if (result.recording.transcripts === undefined) {
            if (!metadata.current.unavailable.has(result.recording.id)) metadata.current.unlisted.add(result.recording.id);
          } else {
            metadata.current.unlisted.delete(result.recording.id);
            metadata.current.unavailable.delete(result.recording.id);
          }
        }
        next = {
          ...next,
          episodes: next.episodes.map((session) => ({
            ...session,
            recordings: session.recordings.map((recording) =>
              result.kind === "recording" && recording.id === result.recording.id
                ? { ...recording, ...result.recording, transcripts: result.recording.transcripts ?? recording.transcripts }
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
  const [savingLanguage, setSavingLanguage] = useState(false);
  useJumpTarget(state.kind === "ready");
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
        <div style={{ marginTop: "var(--space-6)" }}>
          <ErrorPanel title="Couldn’t load this call" detail={errorMessage(state.error)} onRetry={reload} />
        </div>
      </div>
    );

  const { call, inviteUrl, episodes, live, nextCursor, knocks } = state.data;
  const current = episodes.find((episode) => episode.status === "active");
  const past = episodes.filter((episode) => episode !== current);

  // Settings apply on the spot and roll back if the server refuses, so a choice never waits on the network.
  async function setAdmission(admission: Admission) {
    const before = call.admission;
    if (admission === before) return;
    update((data) => ({ ...data, call: { ...data.call, admission } }));
    try {
      const { call: changed } = await act("call", { action: "set-admission", spaceId, admission });
      update((data) => ({ ...data, call: changed }));
    } catch (error) {
      update((data) => ({ ...data, call: { ...data.call, admission: before } }));
      toast(errorMessage(error), { icon: "alert" });
    }
  }

  async function setLanguage(transcriptLanguage: NewCallLanguage) {
    const before = call.transcriptLanguage ?? null;
    if (transcriptLanguage === before) return;
    update((data) => ({ ...data, call: { ...data.call, transcriptLanguage } }));
    setSavingLanguage(true);
    try {
      const { call: changed } = await act("call", { action: "set-transcript-language", spaceId, transcriptLanguage });
      update((data) => ({ ...data, call: changed }));
      if (transcriptLanguage && transcriptLanguage !== "auto") rememberLanguage(transcriptLanguage);
    } catch (error) {
      update((data) => ({ ...data, call: { ...data.call, transcriptLanguage: before } }));
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setSavingLanguage(false);
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
    if (pendingDecisions.current.has(handle) || knocks.find((knock) => knock.handle === handle)?.decisionState === "in_flight") return;
    pendingDecisions.current.add(handle);
    try {
      const intent = `${allow ? "approve" : "deny"}:${handle}`;
      await act("call", { action: allow ? "approve-knock" : "deny-knock", spaceId, requestHandle: handle, idempotencyKey: intents.key(intent) });
      intents.done(intent);
      // The next authoritative status replaces optimistic progress, including retryable failures.
      update((data) => ({ ...data, knocks: data.knocks.map((knock): CallPageDTO["knocks"][number] => (knock.handle === handle ? { ...knock, decisionState: "in_flight", decisionAction: allow ? "approve" : "deny" } : knock)) }), { refresh: false });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      pendingDecisions.current.delete(handle);
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
        <Link className="btn pri" to="/dashboard/call/$spaceId/join" params={{ spaceId }} preload="intent" onClick={() => rememberJoiningCall(call)}>
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
      <AdmissionKnocks knocks={knocks} onDecision={answerKnock} />
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
        <div id="access">
          <h2 id="who-can-join">Who can join</h2>
          <Seg labelledBy="who-can-join" options={ADMISSION} value={call.admission} onChange={(value) => void setAdmission(value)} />
          <p className="help swap" key={call.admission}>
            {call.admission === "anyone" ? "People with the link join right away." : "People ask to join, and someone in the call lets them in."}
          </p>
        </div>
        <div id="transcript-language">
          <h2 id="transcript-language-label">Transcript language</h2>
          <LanguagePicker id="transcript-language-picker" labelledBy="transcript-language-label" describedBy="transcript-language-help" allowDefault value={call.transcriptLanguage ?? null} loading={savingLanguage} loadingLabel="Saving…" onChange={(value) => void setLanguage(value)} />
          <p className="help" id="transcript-language-help">
            Applies to new transcripts for this call.
          </p>
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
            <div className="slist ses one">
              <SessionsHead />
              {past.map((episode) => (
                <SessionRow key={episode.id} row={{ spaceId, episodeId: episode.id, startedAt: episode.startedAt, endedAt: episode.endedAt, people: episode.participantCount, ...kept(episode.recordings, metadata.current.unavailable) }} />
              ))}
            </div>
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

/** What a session kept: its newest recording's video, and that recording's best transcript. */
function kept(recordings: readonly RecordingDTO[], unavailable: ReadonlySet<string>): Pick<RowModel, "video" | "transcript"> {
  const recording = keptRecording(recordings);
  if (!recording) return { video: null, transcript: "none" };
  const video = videoState(recording);
  if (unavailable.has(recording.id)) return { video, transcript: "unavailable" };
  const transcripts = recording.transcripts ?? [];
  if (transcripts.some((item) => item.status === "completed" || item.status === "complete")) return { video, transcript: "ready" };
  if (transcripts.some((item) => PENDING_TRANSCRIPTS.has(item.status))) return { video, transcript: "processing" };
  return { video, transcript: "none" };
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
        <div>
          <Sk width="50%" height={14} />
          <div style={{ height: 12 }} />
          <Sk width="100%" height={40} radius="8px" />
        </div>
      </div>
      <div className="secth">
        <Sk width="160px" height={18} />
      </div>
      <SkeletonRows count={4} />
    </div>
  );
}
