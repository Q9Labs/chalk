import { useEffect, useRef, useState } from "react";
import { HOME_STATUS_ROWS, type CallDTO, type HomeCallDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { Icon } from "../site/Icon";
import { useLoad, type Update } from "./use-dashboard";
import type { Load } from "./load-machine";
import { MoreButton, SkeletonRows, useToast } from "./kit";
import { newCallIntent, startCall as startOwnedCall } from "./language-choice";
import { type Row, type Home, merge, capped, listed, rowsOf, newestFirst, replay, readHomeStatus } from "./home-rows";
import { CallRow } from "./HomeRow";
import { useJoinCall, usePendingJoin } from "./join-call";
import { JoinLinkField, RenameDialog } from "./HomeDialogs";

type HomeDialog = null | { kind: "rename"; call: HomeCallDTO };
type UpdateHome = Update<Home>;

function useCallActions(update: UpdateHome, join: (call: CallDTO) => void) {
  const [starting, setStarting] = useState(false);
  const toast = useToast();
  const startKey = useRef(newCallIntent());

  async function startCall() {
    if (starting) return;
    setStarting(true);
    try {
      const { call } = await startOwnedCall(startKey.current);
      startKey.current = newCallIntent();
      const row: Row = { ...call, inviteUrl: null, lastActiveAt: null, recentPeople: [], live: null };
      update((home) => ({ ...home, rows: capped([row, ...home.rows]) }));
      join(call);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setStarting(false);
    }
  }

  async function archive(call: Row) {
    try {
      await act("home", { action: "archive-call", spaceId: call.id });
      update((home) => ({ ...home, rows: home.rows.map((item) => (item.id === call.id ? { ...item, archived: true } : item)) }));
      toast(`Archived ${call.name}`, {
        action: {
          label: "Undo",
          onClick: () => {
            act("home", { action: "restore-call", spaceId: call.id }).then(
              ({ call: restored }) =>
                update((home) => {
                  // New calls may have pushed the archived row out of the 300, so put it back in its place.
                  const row = home.rows.find((item) => item.id === call.id) ?? call;
                  return { ...home, rows: capped([...home.rows.filter((item) => item.id !== call.id), merge(row, restored)].sort(newestFirst)) };
                }),
              (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
            );
          },
        },
      });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }

  return { starting, startCall, archive };
}

type HomeBodyProps = { readonly state: Load<Home>; readonly reload: () => void; readonly update: UpdateHome; readonly onRename: (call: HomeCallDTO) => void; readonly onArchive: (call: Row) => void };

function HomeBody({ state, reload, update, onRename, onArchive }: HomeBodyProps) {
  return (
    <>
      {state.kind === "loading" ? (
        <SkeletonRows count={4} />
      ) : state.kind === "error" ? (
        <HomeLoadFailed detail={errorMessage(state.error)} onRetry={reload} />
      ) : listed(state.data).length === 0 ? (
        <div className="list">
          <div className="empty">
            <b>No calls yet</b>
            <p>Start a call to get a link you can share and use again. Your calls show here.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="list calls">
            {listed(state.data).map((call) => (
              <CallRow key={call.id} call={call} live={call.live} onRename={() => onRename(call)} onArchive={() => onArchive(call)} />
            ))}
          </div>
          {state.data.rows.length >= HOME_STATUS_ROWS ? (
            <p className="help">Home shows your 300 most recent calls.</p>
          ) : state.data.nextCursor ? (
            <MoreButton
              label="Show more calls"
              cursor={state.data.nextCursor}
              load={(cursor) => readPage("home", { cursor })}
              onLoaded={(page) => {
                // A call made elsewhere may already be on top, so skip calls the list already holds.
                update(
                  (home) => {
                    const known = new Set(home.rows.map((row) => row.id));
                    return { rows: capped([...home.rows, ...rowsOf(page).filter((row) => !known.has(row.id))]), nextCursor: page.nextCursor };
                  },
                  { refresh: false },
                );
              }}
            />
          ) : null}
        </>
      )}
    </>
  );
}

export function HomePage() {
  const held = useRef<Row[]>([]);
  const { state, reload, update } = useLoad<Home>(async () => replay(held.current, await readPage("home", {})), "home", {
    // Like a call page, Home checks every five seconds while visible. Each check is one request that answers for
    // every call Home holds: its live state, whether it is archived, its last active time and recent people, and the
    // first page when a call was made elsewhere. A failed check keeps the old rows and the next one catches up.
    interval: () => 5000,
    read: readHomeStatus,
  });
  useEffect(() => {
    if (state.kind === "ready") held.current = state.data.rows;
  }, [state]);
  const [dialog, setDialog] = useState<HomeDialog>(null);
  const joinCall = useJoinCall();
  const { starting, startCall, archive } = useCallActions(update, joinCall);
  // The button keeps working until the call page has taken over, so Start a call never looks idle between the two.
  const joining = usePendingJoin() !== null;
  const opening = starting || joining;

  return (
    <div className="wrap">
      <div className="secth hhead">
        <h1>Recent calls</h1>
        <div className="hact">
          <button type="button" className="btn pri" aria-busy={opening || undefined} onClick={() => void startCall()}>
            {opening ? <span className="spin" aria-hidden="true" /> : <Icon name="plus" />}
            Start a call
          </button>
          <JoinLinkField />
        </div>
      </div>
      <HomeBody state={state} reload={reload} update={update} onRename={(call) => setDialog({ kind: "rename", call })} onArchive={(call) => void archive(call)} />
      {dialog?.kind === "rename" ? <RenameDialog call={dialog.call} page="home" onClose={() => setDialog(null)} onRenamed={(renamed) => update((home) => ({ ...home, rows: home.rows.map((item) => (item.id === renamed.id ? merge(item, renamed) : item)) }))} /> : null}
    </div>
  );
}

function HomeLoadFailed({ detail, onRetry }: { readonly detail: string; readonly onRetry: () => void }) {
  return (
    <div className="hfail" role="alert">
      <svg className="hfail-art" viewBox="0 0 160 96" fill="none" aria-hidden="true">
        <rect x="14" y="10" width="132" height="24" rx="8" className="hfail-tile" />
        <circle cx="30" cy="22" r="6" className="hfail-dot" />
        <rect x="44" y="17" width="46" height="4" rx="2" className="hfail-bar" />
        <rect x="44" y="24" width="28" height="3" rx="1.5" className="hfail-bar" />
        <rect x="14" y="40" width="132" height="24" rx="8" className="hfail-tile" />
        <circle cx="30" cy="52" r="6" className="hfail-dot" />
        <rect x="44" y="47" width="38" height="4" rx="2" className="hfail-bar" />
        <rect x="44" y="54" width="22" height="3" rx="1.5" className="hfail-bar" />
        <path d="M14 82h50M96 82h50" className="hfail-line" />
        <circle cx="80" cy="82" r="7" className="hfail-badge" />
        <path d="M80 78.5v4M80 85.5v.01" className="hfail-mark" />
      </svg>
      <b>Couldn’t load your calls</b>
      <p>{detail}</p>
      <button type="button" className="btn sec" onClick={onRetry}>
        <Icon name="retry" />
        Try again
      </button>
    </div>
  );
}
