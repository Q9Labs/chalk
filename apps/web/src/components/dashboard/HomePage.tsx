import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { HOME_STATUS_ROWS, type CallDTO, type HomeCallDTO } from "../../lib/dashboard/contracts";
import { act, DashboardRequestError, errorMessage, readPage } from "../../lib/dashboard/client";
import { Icon } from "../site/Icon";
import { useLoad, type Update } from "./use-dashboard";
import type { Load } from "./load-machine";
import { MoreButton, SkeletonRows, useToast } from "./kit";
import { createCallAction, newCallIntent, readNewCallLanguage } from "./language-choice";
import { inviteLink, type Row, type Home, merge, capped, listed, SHOWN_ROWS, rowsOf, newestFirst, replay, readHomeStatus } from "./home-rows";
import { CallRow } from "./HomeRow";
import { CallReadyDialog, JoinLinkField, RenameDialog } from "./HomeDialogs";

type HomeDialog = null | { kind: "ready"; call: CallDTO; link: string } | { kind: "rename"; call: HomeCallDTO };
type UpdateHome = Update<Home>;

function useCallActions(update: UpdateHome, show: (dialog: HomeDialog) => void) {
  const [starting, setStarting] = useState(false);
  const toast = useToast();
  const startKey = useRef(newCallIntent());

  async function startCall() {
    if (starting) return;
    setStarting(true);
    try {
      // No name: the server names it, and the person can rename it from the row.
      const { call } = await act("home", createCallAction(startKey.current, readNewCallLanguage()));
      startKey.current = newCallIntent();
      const row: Row = { ...call, inviteUrl: null, lastActiveAt: null, recentPeople: [], live: null };
      update((home) => ({ ...home, rows: capped([row, ...home.rows]) }));
      const link = await inviteLink(row);
      update((home) => ({ ...home, rows: home.rows.map((item) => (item.id === call.id ? { ...item, inviteUrl: link } : item)) }));
      show({ kind: "ready", call, link });
    } catch {
      // The reason belongs to the engine; the person needs the outcome and a way to retry.
      toast("Couldn’t start a call", { icon: "alert", action: { label: "Try again", onClick: () => void startCall() } });
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
  const [limit, setLimit] = useState(SHOWN_ROWS);
  return (
    <>
      {state.kind === "loading" ? (
        <SkeletonRows count={4} />
      ) : state.kind === "error" ? (
        <HomeLoadFailed error={state.error} onRetry={reload} />
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
            {listed(state.data)
              .slice(0, limit)
              .map((call) => (
                <CallRow key={call.id} call={call} live={call.live} onRename={() => onRename(call)} onArchive={() => onArchive(call)} />
              ))}
          </div>
          {listed(state.data).length > limit ? (
            <div className="more-row">
              <button type="button" className="btn sec sm" onClick={() => setLimit((value) => value + SHOWN_ROWS)}>
                Show more calls
              </button>
            </div>
          ) : state.data.rows.length >= HOME_STATUS_ROWS ? (
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
                setLimit((value) => value + SHOWN_ROWS);
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
  const navigate = useNavigate();
  const { starting, startCall, archive } = useCallActions(update, (next) => setDialog(next));

  return (
    <div className="wrap">
      <div className="secth hhead">
        <h1>Recent calls</h1>
        <div className="hact">
          <button type="button" className="btn pri" aria-busy={starting || undefined} onClick={() => void startCall()}>
            <Icon name="plus" />
            Start a call
          </button>
          <JoinLinkField />
        </div>
      </div>
      <HomeBody state={state} reload={reload} update={update} onRename={(call) => setDialog({ kind: "rename", call })} onArchive={(call) => void archive(call)} />
      {dialog?.kind === "ready" ? (
        <CallReadyDialog
          call={dialog.call}
          link={dialog.link}
          onLanguage={(call) => update((home) => ({ ...home, rows: home.rows.map((item) => (item.id === call.id ? merge(item, call) : item)) }))}
          onJoin={() => void navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: dialog.call.id } })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "rename" ? <RenameDialog call={dialog.call} page="home" onClose={() => setDialog(null)} onRenamed={(renamed) => update((home) => ({ ...home, rows: home.rows.map((item) => (item.id === renamed.id ? merge(item, renamed) : item)) }))} /> : null}
    </div>
  );
}

/** What a failed Home read means for the person: their calls are safe, and what to do next. */
function homeFailure(error: unknown): string {
  if (!(error instanceof DashboardRequestError)) return "Your calls are still saved. Check your connection, then try again.";
  if (error.status >= 500) return "Chalk couldn’t reach your calls just now. They’re still saved, so try again in a moment.";
  return errorMessage(error);
}

/** The Home list could not load: what failed, what it means, and one way to retry. */
function HomeLoadFailed({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <div className="hfail" role="alert">
      <b>Couldn’t load your calls</b>
      <p>{homeFailure(error)}</p>
      <button type="button" className="btn sec" onClick={onRetry}>
        <Icon name="retry" />
        Try again
      </button>
    </div>
  );
}
