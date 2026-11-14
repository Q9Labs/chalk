import { useMemo, useState } from "react";

import { TRANSCRIPT } from "../../lib/dashboard/recording";
import { playbackTime } from "../../lib/dashboard/format";
import type { TranscriptView } from "../../lib/dashboard/tracking";
import { Avatar } from "../site/Avatar";
import { Icon } from "../site/Icon";
import { ContactSupport } from "./ContactSupport";
import { ErrorPanel } from "./kit";

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

type Cue = Extract<TranscriptView, { kind: "ready" }>["cues"][number];

function CueLine({ cue, mark, active, onSeek }: { readonly cue: Cue; readonly mark: RegExp | null; readonly active: boolean; readonly onSeek: ((seconds: number) => void) | undefined }) {
  const at = playbackTime(cue.startMs / 1000);
  const speaker = cue.speaker?.name;
  const content = (
    <>
      <span className="mono num">{at}</span>
      <span>
        {speaker ? (
          <b>
            <Avatar name={speaker} size={18} />
            {speaker}
          </b>
        ) : null}
        {mark ? cue.text.split(mark).map((part: string, n: number) => (n % 2 ? <mark key={n}>{part}</mark> : part)) : cue.text}
      </span>
    </>
  );
  if (!onSeek) return <div className="tline">{content}</div>;
  return (
    <button type="button" className={active ? "tline on" : "tline"} aria-label={`Play from ${at}${speaker ? `, ${speaker}` : ""}: ${cue.text}`} aria-current={active ? true : undefined} onClick={() => onSeek(cue.startMs / 1000)}>
      {content}
    </button>
  );
}

/** Why there are no lines yet, and what can be done about it. */
function TranscriptNote({ transcript, creating, onCreate }: { readonly transcript: Exclude<TranscriptView, { kind: "ready" | "loading" | "unreadable" }>; readonly creating: boolean; readonly onCreate: () => void }) {
  const state = TRANSCRIPT[transcript.kind];
  return (
    <div className="tempty" role={transcript.kind === "failed" ? "alert" : undefined}>
      {transcript.kind === "preparing" ? <span className="spin" aria-hidden="true" /> : <Icon name="file" />}
      <div>
        <b>{state.title}</b>
        <p>{state.detail}</p>
      </div>
      {state.action === "create" ? (
        <button type="button" className="btn sec sm" aria-busy={creating || undefined} onClick={onCreate}>
          <Icon name="file" />
          Make a transcript
        </button>
      ) : transcript.kind === "failed" ? (
        <ContactSupport problem={state.title} size="sm" />
      ) : null}
    </div>
  );
}

function TranscriptSearch({ query, onChange }: { readonly query: string; readonly onChange: (query: string) => void }) {
  return (
    <div className="tsearch">
      <Icon name="search" />
      <label className="sr" htmlFor="transcript-search">
        Search transcript
      </label>
      <input id="transcript-search" className="inp" value={query} placeholder="Search transcript" autoComplete="off" onChange={(event) => onChange(event.target.value)} />
      {query.trim() ? (
        <button type="button" className="ib" aria-label="Clear search" onClick={() => onChange("")}>
          <Icon name="x" />
        </button>
      ) : null}
    </div>
  );
}

type PanelProps = { readonly transcript: TranscriptView; readonly time: number; readonly from?: string; readonly onSeek?: (seconds: number) => void; readonly onCreate: () => Promise<void> };

export function TranscriptPanel({ transcript, time, from, onSeek, onCreate }: PanelProps) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const search = query.trim().toLowerCase();
  const cues = transcript.kind === "ready" ? transcript.cues : [];
  const active = cues.reduce((found, cue, index) => (cue.startMs / 1000 <= time ? index : found), -1);
  const lines = useMemo(() => cues.map((cue, index) => ({ cue, index })).filter(({ cue }) => !search || cue.text.toLowerCase().includes(search)), [cues, search]);
  const mark = useMemo(() => (search ? new RegExp(`(${search.replace(ESCAPE, "\\$&")})`, "ig") : null), [search]);
  const create = () => {
    if (creating) return;
    setCreating(true);
    void onCreate().finally(() => setCreating(false));
  };

  function body() {
    if (transcript.kind === "loading")
      return (
        <div className="tempty" role="status">
          <span className="spin" aria-hidden="true" />
          Loading the transcript…
        </div>
      );
    if (transcript.kind === "unreadable")
      return (
        <div style={{ padding: "var(--space-3)" }}>
          <ErrorPanel title="Couldn’t load the transcript" detail={transcript.message} />
        </div>
      );
    if (transcript.kind !== "ready") return <TranscriptNote transcript={transcript} creating={creating} onCreate={create} />;
    if (!lines.length) return <div className="tempty">No lines mention “{query.trim()}”.</div>;
    return lines.map(({ cue, index }) => <CueLine key={index} cue={cue} mark={mark} active={index === active} onSeek={onSeek} />);
  }

  // With no lines to read there is nothing to search, so the state shows on its own, in the card around it.
  if (transcript.kind !== "ready") return <div className="tbody">{body()}</div>;
  return (
    <section className="tpanel" aria-labelledby="transcript-heading">
      <div className="thead">
        <h2 id="transcript-heading">
          Transcript
          {search && transcript.kind === "ready" ? (
            <span role="status">
              {lines.length} {lines.length === 1 ? "line" : "lines"}
            </span>
          ) : from ? (
            <span>From the {from} recording</span>
          ) : null}
        </h2>
        {transcript.kind === "ready" ? <TranscriptSearch query={query} onChange={setQuery} /> : null}
      </div>
      <div className="tlines">{body()}</div>
    </section>
  );
}
