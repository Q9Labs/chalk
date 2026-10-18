import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import type { CallPageDTO, EpisodeDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { clock, displayLink, duration, sessionDay } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { useLoad } from "./AppShell";
import { RenameDialog } from "./HomePage";
import { CopyAction, ErrorPanel, Menu, MenuItem, MoreButton, Seg, Sk, SkeletonRows, useIntentKeys, usePhone, useToast } from "./kit";

type Admission = CallPageDTO["call"]["admission"];
const ADMISSION: readonly (readonly [Admission, string])[] = [
  ["anyone", "Anyone with the link"],
  ["knock", "Ask to join"],
];

export function CallPage({ spaceId }: { readonly spaceId: string }) {
  const { state, reload, update } = useLoad(() => readPage("call", { spaceId }), `call:${spaceId}`);
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

  const { call, inviteUrl, episodes, nextCursor, knocks } = state.data;
  const live = episodes.find((episode) => episode.status === "active");
  const past = episodes.filter((episode) => episode !== live);

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
          <span className="mu">People are in the call. It started at {clock(live.startedAt)}.</span>
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
          {nextCursor ? <MoreButton label="Show older sessions" cursor={nextCursor} load={(cursor) => readPage("call", { spaceId, cursor })} onLoaded={(page) => update((data) => ({ ...data, episodes: [...data.episodes, ...page.episodes], nextCursor: page.nextCursor }))} /> : null}
        </>
      )}
      {renaming ? <RenameDialog call={call} page="call" onClose={() => setRenaming(false)} onRenamed={(renamed) => update((data) => ({ ...data, call: renamed }))} /> : null}
    </div>
  );
}

function SessionRow({ spaceId, episode }: { readonly spaceId: string; readonly episode: EpisodeDTO }) {
  const phone = usePhone();
  const day = sessionDay(episode.startedAt);
  const range = episode.endedAt ? `${clock(episode.startedAt)} to ${clock(episode.endedAt)}` : `${clock(episode.startedAt)}, ending`;
  const length = episode.endedAt ? duration(episode.startedAt, episode.endedAt) : "";
  const link = <Link className="ra" to="/dashboard/call/$spaceId/session/$episodeId" params={{ spaceId, episodeId: episode.id }} aria-label={`Session ${day}, ${range}${length ? `, ${length}` : ""}`} />;
  if (phone)
    return (
      <div className="row">
        {link}
        <span className="rt np">
          <b>
            {day}, {clock(episode.startedAt)}
          </b>
          <span>{length || "Ending"}</span>
        </span>
        <Icon name="right" />
      </div>
    );
  return (
    <div className="row srow">
      {link}
      <span className="np">{day}</span>
      <span className="np num mu">{range}</span>
      <span className="np num mu">{length}</span>
      {/* Who came and what was kept go here once EpisodeDTO carries them. */}
      <span className="np" />
      <span className="kept np" />
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
