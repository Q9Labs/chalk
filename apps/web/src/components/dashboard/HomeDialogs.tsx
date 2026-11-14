import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { spaceNameMaxCodePoints, type CallDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage } from "../../lib/dashboard/client";
import { displayLink } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import { Dialog } from "./Dialog";
import { CopyAction, useToast } from "./kit";
import { usePendingJoin } from "./join-call";
import { LanguagePicker } from "./LanguagePicker";
import { readNewCallLanguage, rememberLanguage, saveNewCallLanguage, type NewCallLanguage } from "./language-choice";
import { SITE_HOST } from "../../lib/site-origin";

export function CallReadyDialog({ call, link, onLanguage, onJoin, onClose }: { readonly call: CallDTO; readonly link: string; readonly onLanguage: (call: CallDTO) => void; readonly onJoin: () => void; readonly onClose: () => void }) {
  const [language, setLanguage] = useState<NewCallLanguage>(call.transcriptLanguage ?? readNewCallLanguage());
  const joining = usePendingJoin() === call.id;
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  // The choice applies to this call and becomes the start for the next one, so it lives where a call is made.
  async function chooseLanguage(next: NewCallLanguage) {
    const before = language;
    setLanguage(next);
    setSaving(true);
    try {
      const { call: saved } = await act("home", { action: "set-transcript-language", spaceId: call.id, transcriptLanguage: next });
      saveNewCallLanguage(next);
      if (next && next !== "auto") rememberLanguage(next);
      onLanguage(saved);
    } catch (error) {
      setLanguage(before);
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      title="Your call is ready"
      description="Share this link with the people you want in the call. It keeps working after the call ends."
      onClose={onClose}
      actions={
        <button type="button" className="btn pri" aria-busy={joining || undefined} onClick={onJoin}>
          {joining ? <span className="spin" aria-hidden="true" /> : <Icon name="cam" />}
          Join call
        </button>
      }
    >
      <div className="linkrow" style={{ marginTop: "var(--space-4)" }}>
        <div className="linkbox">
          <span>{displayLink(link)}</span>
        </div>
        <CopyAction text={link} pill />
      </div>
      <p className="help" style={{ marginTop: "var(--space-3)" }}>
        People ask to join, and you let them in.{" "}
        <Link to="/dashboard/call/$spaceId" params={{ spaceId: call.id }} hash="access">
          Change who can join
        </Link>
      </p>
      <div className="field" style={{ marginTop: "var(--space-5)" }}>
        <span className="lbl" id="ready-language-label">
          Transcript language
        </span>
        <LanguagePicker id="ready-language" labelledBy="ready-language-label" describedBy="ready-language-help" allowDefault value={language} loading={saving} loadingLabel="Saving…" onChange={(next) => void chooseLanguage(next)} />
        <p className="help" id="ready-language-help">
          Your next calls start with this choice too.
        </p>
      </div>
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
    const chalk = url.protocol === "https:" && !url.port && url.hostname.replace(/^www\./, "") === SITE_HOST;
    if ((!chalk && url.origin !== window.location.origin) || url.username || url.password) return null;
    return CALL_LINK.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

/** Joining by link is the second way into a call, so it is a quiet field beside Start a call: paste, then Enter or Join. */
export function JoinLinkField() {
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <form
      className="hjoin"
      onSubmit={(event) => {
        event.preventDefault();
        const link = parseCallLink(value);
        if (link) window.location.assign(link);
        else setBad(true);
      }}
    >
      <label className={bad ? "hjoin-box bad" : "hjoin-box"}>
        <Icon name="link" />
        <input
          value={value}
          placeholder="Paste a call link to join"
          aria-label="Call link to join"
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
        {value.trim() ? (
          <button type="submit" className="btn sm sec">
            Join
          </button>
        ) : null}
      </label>
      {bad ? (
        <p className="err" id="join-link-error" role="alert">
          <Icon name="alert" />
          That isn’t a Chalk link. A call link looks like chalkmeet.com/q9-team.
        </p>
      ) : null}
    </form>
  );
}

/** The typed name, or the previous one when the new text goes past the name limit and isn't shorter. */
function typed(next: string, current: string): string {
  const nextLength = Array.from(next).length;
  return nextLength <= spaceNameMaxCodePoints || nextLength <= Array.from(current).length ? next : current;
}

function RenameField({ value, bad, onChange }: { readonly value: string; readonly bad: boolean; readonly onChange: (value: string) => void }) {
  return (
    <div className="field" style={{ marginTop: "var(--space-4)" }}>
      <label className="lbl" htmlFor="rename-input">
        Name
      </label>
      <input id="rename-input" className={bad ? "inp bad" : "inp"} value={value} autoComplete="off" aria-invalid={bad} aria-describedby={bad ? "rename-error" : undefined} onChange={(event) => onChange(typed(event.target.value, value))} />
      {bad ? (
        <p className="err" id="rename-error">
          <Icon name="alert" />
          Give the call a name.
        </p>
      ) : null}
    </div>
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
      <RenameField
        value={value}
        bad={bad}
        onChange={(next) => {
          setValue(next);
          setBad(false);
        }}
      />
    </Dialog>
  );
}

/** The Home list could not load: a card that shows a call tile cut off from the network, with one way to retry. */
