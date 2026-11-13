import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";

import type { CallPageDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { clock } from "../../lib/dashboard/format";
import { Faces } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { useLoad, type Update } from "./use-dashboard";
import { RenameDialog } from "./HomeDialogs";
import { AdmissionKnocks } from "./AdmissionKnocks";
import { SessionRow, SessionsHead } from "./ListParts";
import { useJumpTarget } from "./jump";
import { callInterval, keptByRow, loadCallPage, newCallRefresh, readCallTick, type CallRefresh } from "./call-refresh";
import { CallSettings } from "./call-settings";
import { ErrorPanel, Menu, MoreButton, RenameArchiveItems, Sk, SkeletonRows, useIntentKeys, useToast } from "./kit";

export function CallPage({ spaceId }: { readonly spaceId: string }) {
  const refresh = useRef(newCallRefresh(spaceId));
  const { state, reload, update } = useLoad(() => loadCallPage(spaceId, refresh.current), `call:${spaceId}`, {
    visibility: "status",
    interval: (data) => callInterval(data, refresh.current),
    read: (data) => readCallTick(data, spaceId, refresh.current),
  });
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
  return <CallLoaded spaceId={spaceId} data={state.data} back={back} refresh={refresh.current} update={update} />;
}

type CallLoadedProps = { readonly spaceId: string; readonly data: CallPageDTO; readonly back: ReactNode; readonly refresh: CallRefresh; readonly update: Update<CallPageDTO> };

function CallLoaded({ spaceId, data, back, refresh, update }: CallLoadedProps) {
  const pendingDecisions = useRef(new Set<string>());
  const [renaming, setRenaming] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const intents = useIntentKeys();
  const { call, inviteUrl, episodes, live, nextCursor, knocks } = data;
  const current = episodes.find((episode) => episode.status === "active");
  const past = episodes.filter((episode) => episode !== current);

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
      <CallHeader spaceId={spaceId} name={call.name} onRename={() => setRenaming(true)} onArchive={() => void archive()} />
      {live ? <LiveBanner participants={live.participants.map((person) => person.name)} startedAt={current?.startedAt} /> : null}
      <AdmissionKnocks knocks={knocks} onDecision={answerKnock} />
      <CallSettings spaceId={spaceId} call={call} inviteUrl={inviteUrl} update={update} />
      <PastSessions spaceId={spaceId} past={past} nextCursor={nextCursor} refresh={refresh} update={update} />
      {renaming ? <RenameDialog call={call} page="call" link={inviteUrl} onClose={() => setRenaming(false)} onRenamed={(renamed) => update((data) => ({ ...data, call: renamed }))} /> : null}
    </div>
  );
}

function CallHeader({ spaceId, name, onRename, onArchive }: { readonly spaceId: string; readonly name: string; readonly onRename: () => void; readonly onArchive: () => void }) {
  return (
    <div className="pgh">
      <h1>
        {name}
        <Menu label={`More actions for ${name}`} align="left">
          {(close) => (
            <>
              <RenameArchiveItems close={close} onRename={onRename} onArchive={onArchive} />
            </>
          )}
        </Menu>
      </h1>
      <Link className="btn pri" to="/dashboard/call/$spaceId/join" params={{ spaceId }}>
        <Icon name="cam" />
        Join call
      </Link>
    </div>
  );
}

function LiveBanner({ participants, startedAt }: { readonly participants: readonly string[]; readonly startedAt: string | undefined }) {
  return (
    <div className="liveb" role="status">
      <span className="live">
        <span className="dot" />
        Live now
      </span>
      {participants.length ? <Faces names={participants} size={28} /> : null}
      <span className="mu">
        {inCall(participants)}
        {startedAt ? ` It started at ${clock(startedAt)}.` : ""}
      </span>
    </div>
  );
}

type PastSessionsProps = {
  readonly spaceId: string;
  readonly past: CallPageDTO["episodes"];
  readonly nextCursor: CallPageDTO["nextCursor"];
  readonly refresh: CallRefresh;
  readonly update: (change: (data: CallPageDTO) => CallPageDTO, options?: { refresh?: boolean }) => void;
};

function PastSessions({ spaceId, past, nextCursor, refresh, update }: PastSessionsProps) {
  return (
    <>
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
                <SessionRow key={episode.id} row={{ spaceId, episodeId: episode.id, startedAt: episode.startedAt, endedAt: episode.endedAt, people: episode.participantCount, ...keptByRow(episode.recordings, refresh.unavailable) }} />
              ))}
            </div>
          </div>
          {nextCursor ? (
            <MoreButton
              label="Show older sessions"
              cursor={nextCursor}
              load={(cursor) => readPage("call", { spaceId, cursor })}
              onLoaded={(page) => {
                refresh.pages++;
                update((data) => ({ ...data, episodes: [...data.episodes, ...page.episodes], nextCursor: page.nextCursor }), { refresh: false });
              }}
            />
          ) : null}
        </>
      )}
    </>
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
