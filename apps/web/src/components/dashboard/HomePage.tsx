import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { HOME_STATUS_ROWS, spaceNameMaxCodePoints, type CallDTO, type HomeCallDTO, type HomeDTO, type HomeStatusDTO, type LiveDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, intentKey, readPage } from "../../lib/dashboard/client";
import { displayLink, lastActive } from "../../lib/dashboard/format";
import { Avatar, Faces } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { useLoad } from "./AppShell";
import { CopyAction, Dialog, ErrorPanel, Menu, MenuItem, MoreButton, SkeletonRows, usePhone, useToast } from "./kit";

/** A call's shareable link: the row's own, or a bounded invite-only read. */
async function inviteLink(call: HomeCallDTO): Promise<string> {
  const link = call.inviteUrl ?? (await readPage("call-invite", { spaceId: call.id })).inviteUrl;
  if (!link) throw new Error("This call has no link yet");
  return link;
}

/** A Home row: the call with its live Episode, which every status check answers along with whether it is archived. */
type Row = HomeCallDTO & { live: LiveDTO["episode"] };
/** A mutation returns the bare call; keep the row's link, activity, people and live Episode. */
const merge = (row: Row, call: CallDTO): Row => ({ ...row, ...call });
/**
 * Home holds the 300 newest calls it knows, newest first, archived ones included, and checks them all. It lists only
 * the unarchived ones, so a call archived elsewhere hides in its place and shows again when it is restored. A call that
 * falls below the 300th place drops out, archived or not.
 */
type Home = { rows: Row[]; nextCursor: string | null };
const capped = (rows: Row[]): Row[] => rows.slice(0, HOME_STATUS_ROWS);
const shown = (home: Home): Row[] => home.rows.filter((row) => !row.archived);
const rowsOf = (page: HomeDTO): Row[] => page.calls.map((call) => ({ ...call, live: page.live.find((item) => item.spaceId === call.id)?.episode ?? null }));

/** One status answer applied by Space ID: whether each call is archived, its activity, and its live Episode. */
function withStatus(rows: Row[], status: HomeStatusDTO): Row[] {
  const calls = new Map(status.calls.map((call) => [call.id, call]));
  const episodes = new Map(status.live.map((item) => [item.spaceId, item.episode]));
  return rows.map((row) => {
    const live = episodes.get(row.id);
    return { ...row, ...calls.get(row.id), live: live === undefined ? row.live : live };
  });
}

/**
 * Where a call sits in Home's order: newest first by creation time, then by ID. The engine writes UTC timestamps with
 * up to nine fraction digits and drops trailing zeros, so with the "Z" removed and a space before the ID, which sorts
 * below every digit, the key compares as a string.
 */
const sortKey = (call: HomeCallDTO): string => `${call.createdAt.slice(0, -1)} ${call.id}`;
const newestFirst = (a: HomeCallDTO, b: HomeCallDTO) => (sortKey(a) > sortKey(b) ? -1 : 1);

/**
 * Reloads Home from its first page into `rows`, the list it holds, so expanded rows survive: reads on until a row sorts
 * at or past Home's last row, up to 300 calls, since new calls on top push that depth onto later pages. Pages list only
 * unarchived calls, so a held call within the depth read that no page lists is archived, and it stays hidden in place.
 */
async function replay(rows: Row[], page: HomeDTO): Promise<Home> {
  const end = rows.at(-1);
  const deeper = (call: HomeCallDTO | undefined) => end !== undefined && call !== undefined && newestFirst(call, end) < 0;
  let data = page;
  while (data.nextCursor && data.calls.length < HOME_STATUS_ROWS && deeper(data.calls.at(-1))) {
    const older = await readPage("home", { cursor: data.nextCursor });
    data = { calls: [...data.calls, ...older.calls], live: [...data.live, ...older.live], nextCursor: older.nextCursor };
  }
  const last = data.calls.at(-1);
  const listed = new Set(data.calls.map((call) => call.id));
  const archived = rows.filter((row) => !listed.has(row.id) && (!data.nextCursor || (last !== undefined && newestFirst(row, last) < 0))).map((row) => ({ ...row, archived: true }));
  return { rows: capped([...rowsOf(data), ...archived].sort(newestFirst)), nextCursor: data.nextCursor };
}

export function HomePage() {
  const held = useRef<Row[]>([]);
  const { state, reload, update } = useLoad<Home>(
    async () => {
      const page = await readPage("home", {});
      return replay(held.current, page);
    },
    "home",
    {
      // Like a call page, Home checks every five seconds while visible. Each check is one request that answers for
      // every call Home holds: its live state, whether it is archived, its last active time and recent people, and the
      // first page when a call was made elsewhere. A failed check keeps the old rows and the next one catches up.
      interval: () => 5000,
      read: async (home) => {
        const ids = home.rows.map((row) => row.id);
        const status = await readPage("home-status", { home: "1", ...(ids.length ? { spaceIds: ids.join(",") } : {}) });
        const rows = withStatus(home.rows, status);
        const first = status.first;
        if (!first) return { ...home, rows };
        // Calls made elsewhere are the newest, so they sit above every call Home holds: put the first page's calls above
        // the first one Home knows on top. With no known call on the page (five or more new calls), or an unknown call
        // below a known one (a call archived before Home loaded, then restored), reload from this page into the rows
        // this answer just updated.
        const known = new Set(rows.map((row) => row.id));
        const overlap = first.calls.findIndex((call) => known.has(call.id));
        if (overlap < 0 || first.calls.slice(overlap).some((call) => !known.has(call.id))) return replay(rows, first);
        const discovered = rowsOf(first);
        const byId = new Map(discovered.map((row) => [row.id, row]));
        return { ...home, rows: capped([...discovered.slice(0, overlap), ...rows.map((row) => byId.get(row.id) ?? row)]) };
      },
    },
  );
  useEffect(() => {
    if (state.kind === "ready") held.current = state.data.rows;
  }, [state]);
  const [dialog, setDialog] = useState<null | { kind: "ready"; call: CallDTO; link: string } | { kind: "join" } | { kind: "rename"; call: HomeCallDTO }>(null);
  const [starting, setStarting] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const startKey = useRef(intentKey());

  async function startCall() {
    if (starting) return;
    setStarting(true);
    try {
      // No name: the server names it, and the person can rename it from the row.
      const { call } = await act("home", { action: "create-call", admission: "knock", idempotencyKey: startKey.current });
      startKey.current = intentKey();
      const row: Row = { ...call, inviteUrl: null, lastActiveAt: null, recentPeople: [], live: null };
      update((home) => ({ ...home, rows: capped([row, ...home.rows]) }));
      const link = await inviteLink(row);
      update((home) => ({ ...home, rows: home.rows.map((item) => (item.id === call.id ? { ...item, inviteUrl: link } : item)) }));
      setDialog({ kind: "ready", call, link });
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
        icon: "trash",
        undo: () => {
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
      });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }

  return (
    <div className="wrap">
      <div className="hact">
        <button type="button" className="btn pri" aria-busy={starting || undefined} onClick={() => void startCall()}>
          <Icon name="plus" />
          Start a call
        </button>
        <button type="button" className="btn sec" onClick={() => setDialog({ kind: "join" })}>
          <Icon name="link" />
          Join with a link
        </button>
      </div>
      <div className="secth">
        <h1>Recent calls</h1>
      </div>
      {state.kind === "loading" ? (
        <SkeletonRows count={4} />
      ) : state.kind === "error" ? (
        <ErrorPanel title="Couldn’t load your calls" detail={errorMessage(state.error)} onRetry={reload} />
      ) : shown(state.data).length === 0 ? (
        <div className="list">
          <div className="empty">
            <b>No calls yet</b>
            <p>Start a call to get a link you can share and use again. Your calls show here.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="list">
            {shown(state.data).map((call) => (
              <CallRow key={call.id} call={call} live={call.live} onRename={() => setDialog({ kind: "rename", call })} onArchive={() => void archive(call)} />
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
      {dialog?.kind === "ready" ? <CallReadyDialog link={dialog.link} onJoin={() => void navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: dialog.call.id } })} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "join" ? <JoinLinkDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "rename" ? <RenameDialog call={dialog.call} page="home" onClose={() => setDialog(null)} onRenamed={(renamed) => update((home) => ({ ...home, rows: home.rows.map((item) => (item.id === renamed.id ? merge(item, renamed) : item)) }))} /> : null}
    </div>
  );
}

function CallRow({ call, live, onRename, onArchive }: { readonly call: HomeCallDTO; readonly live: LiveDTO["episode"]; readonly onRename: () => void; readonly onArchive: () => void }) {
  const phone = usePhone();
  const navigate = useNavigate();
  const join = () => void navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: call.id } });
  const status = live ? (
    <span className="live">
      <span className="dot" />
      Live · {live.count} in the call
    </span>
  ) : (
    lastActive(call.lastActiveAt ?? call.createdAt)
  );
  const label = live ? `${call.name}, live now with ${live.count} people` : `${call.name}, last active ${lastActive(call.lastActiveAt ?? call.createdAt)}`;
  const faces = live ? live.participants.map((person) => person.name) : call.recentPeople.map((person) => person.name);
  return (
    <div className="row">
      <Link className="ra" to="/dashboard/call/$spaceId" params={{ spaceId: call.id }} aria-label={label} />
      <span className="fcol np">{faces.length ? <Faces names={faces} size={28} max={phone ? 2 : 3} /> : <Avatar name={call.name} size={28} />}</span>
      <span className="rt np">
        <b>{call.name}</b>
        {phone ? <span>{status}</span> : call.inviteUrl ? <span className="mono">{displayLink(call.inviteUrl)}</span> : null}
      </span>
      {phone ? null : <span className="rm np">{status}</span>}
      <span className="ract">
        {live ? (
          <button type="button" className="btn sec sm" onClick={join}>
            Join
          </button>
        ) : null}
        {phone ? null : <CopyAction text={() => inviteLink(call)} />}
        <Menu label={`More actions for ${call.name}`}>
          {(close) => (
            <>
              <MenuItem
                icon="cam"
                onSelect={() => {
                  close();
                  join();
                }}
              >
                Join call
              </MenuItem>
              <CopyMenuItem call={call} onDone={close} />
              <MenuItem
                icon="edit"
                onSelect={() => {
                  close();
                  onRename();
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
                  onArchive();
                }}
              >
                Archive call
              </MenuItem>
            </>
          )}
        </Menu>
      </span>
    </div>
  );
}

function CopyMenuItem({ call, onDone }: { readonly call: HomeCallDTO; readonly onDone: () => void }) {
  const toast = useToast();
  return (
    <MenuItem
      icon="copy"
      onSelect={() => {
        onDone();
        inviteLink(call)
          .then((link) => navigator.clipboard.writeText(link))
          .then(
            () => toast("Link copied"),
            () => toast("Couldn’t copy the link. Open the call to copy it.", { icon: "alert" }),
          );
      }}
    >
      Copy link
    </MenuItem>
  );
}

function CallReadyDialog({ link, onJoin, onClose }: { readonly link: string; readonly onJoin: () => void; readonly onClose: () => void }) {
  return (
    <Dialog
      title="Your call is ready"
      description="Share this link with the people you want in the call. It keeps working after the call ends."
      onClose={onClose}
      actions={
        <button type="button" className="btn pri" onClick={onJoin}>
          <Icon name="cam" />
          Join call
        </button>
      }
    >
      <div className="linkrow" style={{ marginTop: 18 }}>
        <div className="linkbox">
          <span>{displayLink(link)}</span>
        </div>
        <CopyAction text={link} pill />
      </div>
      <p className="help" style={{ marginTop: 12 }}>
        People ask to join, and you let them in. Change this on the call’s page.
      </p>
    </Dialog>
  );
}

const CALL_LINK = /^\/(?:space\/)?[a-z0-9-]+\/?$/i;

/** The call link as typed, made absolute, if it's a Chalk call link on chalkmeet.com or this site. */
function parseCallLink(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const chalk = url.protocol === "https:" && !url.port && url.hostname.replace(/^www\./, "") === "chalkmeet.com";
    if ((!chalk && url.origin !== window.location.origin) || url.username || url.password) return null;
    return CALL_LINK.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

function JoinLinkDialog({ onClose }: { readonly onClose: () => void }) {
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      title="Join with a link"
      onClose={onClose}
      onSubmit={() => {
        const link = parseCallLink(value);
        if (!link) {
          setBad(true);
          input.current?.focus();
          return;
        }
        window.location.assign(link);
      }}
      actions={
        <>
          <button type="button" className="btn gh" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn pri">
            Join
          </button>
        </>
      }
    >
      <div className="field" style={{ marginTop: 16 }}>
        <label className="lbl" htmlFor="join-link">
          Call link
        </label>
        <input
          ref={input}
          id="join-link"
          className={bad ? "inp bad" : "inp"}
          value={value}
          placeholder="chalkmeet.com/…"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={bad}
          aria-describedby={bad ? "join-link-error" : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setBad(false);
          }}
        />
        {bad ? (
          <p className="err" id="join-link-error">
            <Icon name="alert" />
            That isn’t a Chalk link. A call link looks like chalkmeet.com/q9-team.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export function RenameDialog({ call, page, link, onClose, onRenamed }: { readonly call: CallDTO; readonly page: "home" | "call"; readonly link?: string; readonly onClose: () => void; readonly onRenamed: (call: CallDTO) => void }) {
  const [value, setValue] = useState(call.name);
  const [bad, setBad] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  async function save() {
    const name = value.trim();
    if (!name) {
      setBad(true);
      return;
    }
    setSaving(true);
    try {
      const { call: renamed } = await act(page, { action: "rename-call", spaceId: call.id, name });
      onRenamed(renamed);
      onClose();
      toast(`Renamed to ${renamed.name}`);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      title="Rename call"
      description={link ? `The link stays ${displayLink(link)}.` : "The link stays the same."}
      onClose={onClose}
      onSubmit={() => void save()}
      actions={
        <>
          <button type="button" className="btn gh" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn pri" disabled={saving}>
            Save name
          </button>
        </>
      }
    >
      <div className="field" style={{ marginTop: 16 }}>
        <label className="lbl" htmlFor="rename-input">
          Name
        </label>
        <input
          id="rename-input"
          className={bad ? "inp bad" : "inp"}
          value={value}
          autoComplete="off"
          aria-invalid={bad}
          aria-describedby={bad ? "rename-error" : undefined}
          onChange={(event) => {
            const next = event.target.value;
            const nextLength = Array.from(next).length;
            if (nextLength <= spaceNameMaxCodePoints || nextLength <= Array.from(value).length) setValue(next);
            setBad(false);
          }}
        />
        {bad ? (
          <p className="err" id="rename-error">
            <Icon name="alert" />
            Give the call a name.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
