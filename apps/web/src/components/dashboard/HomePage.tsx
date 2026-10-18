import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import type { CallDTO, HomeDTO, LiveDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, intentKey, readPage } from "../../lib/dashboard/client";
import { displayLink, shortDate } from "../../lib/dashboard/format";
import { Avatar, Faces } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { useLoad } from "./AppShell";
import { CopyAction, Dialog, ErrorPanel, Menu, MenuItem, MoreButton, SkeletonRows, usePhone, useToast } from "./kit";

/** A call's shareable link. Home doesn't carry it, so it's read from the call's page on demand. */
async function inviteLink(spaceId: string): Promise<string> {
  return (await readPage("call", { spaceId })).inviteUrl;
}

export function HomePage() {
  const { state, reload, update } = useLoad(() => readPage("home", {}), "home");
  const [dialog, setDialog] = useState<null | { kind: "ready"; call: CallDTO; link: string } | { kind: "join" } | { kind: "rename"; call: CallDTO }>(null);
  const [starting, setStarting] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const startKey = useRef(intentKey());

  async function startCall() {
    setStarting(true);
    try {
      // The contract needs a name; the person can rename it from the row.
      const { call } = await act("home", { action: "create-call", name: "New call", admission: "knock", idempotencyKey: startKey.current });
      startKey.current = intentKey();
      update((data) => ({ ...data, calls: [call, ...data.calls], live: [{ spaceId: call.id, episode: null }, ...data.live] }));
      setDialog({ kind: "ready", call, link: await inviteLink(call.id) });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setStarting(false);
    }
  }

  async function archive(call: CallDTO) {
    const index = state.kind === "ready" ? state.data.calls.findIndex((item) => item.id === call.id) : -1;
    try {
      await act("home", { action: "archive-call", spaceId: call.id });
      update((data) => ({ ...data, calls: data.calls.filter((item) => item.id !== call.id) }));
      toast(`Archived ${call.name}`, {
        icon: "trash",
        undo: () => {
          act("home", { action: "restore-call", spaceId: call.id }).then(
            ({ call: restored }) => update((data) => ({ ...data, calls: [...data.calls.slice(0, index), restored, ...data.calls.slice(index)] })),
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
        <button type="button" className="btn pri" disabled={starting} onClick={() => void startCall()}>
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
      ) : state.data.calls.length === 0 ? (
        <div className="list">
          <div className="empty">
            <b>No calls yet</b>
            <p>Start a call to get a link you can share and use again. Your calls show here.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="list">
            {state.data.calls.map((call) => (
              <CallRow key={call.id} call={call} live={liveFor(state.data, call.id)} onRename={() => setDialog({ kind: "rename", call })} onArchive={() => void archive(call)} />
            ))}
          </div>
          {state.data.nextCursor ? (
            <MoreButton label="Show more calls" cursor={state.data.nextCursor} load={(cursor) => readPage("home", { cursor })} onLoaded={(page) => update((data) => ({ calls: [...data.calls, ...page.calls], live: [...data.live, ...page.live], nextCursor: page.nextCursor }))} />
          ) : null}
        </>
      )}
      {dialog?.kind === "ready" ? <CallReadyDialog link={dialog.link} onJoin={() => void navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: dialog.call.id } })} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "join" ? <JoinLinkDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "rename" ? <RenameDialog call={dialog.call} page="home" onClose={() => setDialog(null)} onRenamed={(renamed) => update((data) => ({ ...data, calls: data.calls.map((item) => (item.id === renamed.id ? renamed : item)) }))} /> : null}
    </div>
  );
}

function liveFor(data: HomeDTO, spaceId: string): LiveDTO["episode"] {
  return data.live.find((item) => item.spaceId === spaceId)?.episode ?? null;
}

function CallRow({ call, live, onRename, onArchive }: { readonly call: CallDTO; readonly live: LiveDTO["episode"]; readonly onRename: () => void; readonly onArchive: () => void }) {
  const phone = usePhone();
  const navigate = useNavigate();
  const join = () => void navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: call.id } });
  const status = live ? (
    <span className="live">
      <span className="dot" />
      Live · {live.count} in the call
    </span>
  ) : (
    `Created ${shortDate(call.createdAt)}`
  );
  const label = live ? `${call.name}, live now with ${live.count} people` : `${call.name}, created ${shortDate(call.createdAt)}`;
  return (
    <div className="row">
      <Link className="ra" to="/dashboard/call/$spaceId" params={{ spaceId: call.id }} aria-label={label} />
      <span className="fcol np">{live ? <Faces names={live.participants.map((person) => person.name)} size={28} max={phone ? 2 : 3} /> : <Avatar name={call.name} size={28} />}</span>
      <span className="rt np">
        <b>{call.name}</b>
        {phone ? <span>{status}</span> : null}
      </span>
      {phone ? null : <span className="rm np">{status}</span>}
      <span className="ract">
        {live ? (
          <button type="button" className="btn sec sm" onClick={join}>
            Join
          </button>
        ) : null}
        {phone ? null : <CopyAction text={() => inviteLink(call.id)} />}
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
              <CopyMenuItem spaceId={call.id} onDone={close} />
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

function CopyMenuItem({ spaceId, onDone }: { readonly spaceId: string; readonly onDone: () => void }) {
  const toast = useToast();
  return (
    <MenuItem
      icon="copy"
      onSelect={() => {
        onDone();
        inviteLink(spaceId)
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
          maxLength={120}
          autoComplete="off"
          aria-invalid={bad}
          aria-describedby={bad ? "rename-error" : undefined}
          onChange={(event) => {
            setValue(event.target.value);
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
