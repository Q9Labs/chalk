import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { SessionListDTO } from "../../lib/dashboard/contracts";
import { clock, duration, sessionDay } from "../../lib/dashboard/format";
import { bounds, dayValue, mergeFirstPage, RANGE_LABEL, recordingBadge, timeInCalls, transcriptBadge, type Badge, type Bounds, type RowModel } from "../../lib/dashboard/lists";
import type { RangeKind } from "../../lib/dashboard/search";
import { errorMessage } from "../../lib/dashboard/client";
import { Icon, type IconName } from "../site/Icon";
import { Change, type Load } from "./AppShell";
import { useToast } from "./kit";

/* The parts the Sessions list, the Recordings list and the call page's own list have in common. */

/* ---------- side filters ---------- */

export type NavItem = { readonly key: string; readonly label: string; readonly icon?: IconName; readonly dot?: "ok" | "pr" | "wn" | "bd" | ""; readonly on: boolean; readonly href: string; readonly go: () => void; readonly hideOnPhone?: boolean };

export function FilterNav({ label, groups }: { readonly label: string; readonly groups: readonly { readonly cap: string; readonly items: readonly NavItem[] }[] }) {
  return (
    <nav className="side" aria-label={label}>
      {groups.map((group) => (
        <div key={group.cap} style={{ display: "contents" }}>
          <div className="cap">{group.cap}</div>
          {group.items.map((item) => (
            <a
              key={item.key}
              href={item.href}
              className={item.hideOnPhone ? "hide-m" : undefined}
              aria-current={item.on ? "true" : undefined}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                item.go();
              }}
            >
              {item.dot === undefined ? <Icon name={item.icon ?? "users"} size={16} /> : <span className={`dot ${item.dot}`} />}
              {item.label}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

/* ---------- search, range and chips ---------- */

export type RangeChoice = { readonly range: RangeKind | undefined; readonly from?: string; readonly to?: string };

export function ListTools({ q, placeholder, range, now, onSearch, onRange }: { readonly q: string | undefined; readonly placeholder: string; readonly range: Bounds; readonly now: Date; readonly onSearch: (q: string | undefined) => void; readonly onRange: (choice: RangeChoice) => void }) {
  const [text, setText] = useState(q ?? "");
  useEffect(() => setText(q ?? ""), [q]);
  useEffect(() => {
    const next = text.trim() || undefined;
    if (next === q) return;
    const timer = window.setTimeout(() => onSearch(next), 350);
    return () => window.clearTimeout(timer);
  }, [text, q, onSearch]);
  return (
    <div className="ltools">
      <div className="lfld">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          maxLength={200}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSearch(text.trim() || undefined);
          }}
        />
        {text ? (
          <button
            type="button"
            className="ib"
            aria-label="Clear search"
            onClick={() => {
              setText("");
              onSearch(undefined);
            }}
          >
            <Icon name="x" size={14} />
          </button>
        ) : null}
      </div>
      <RangeMenu range={range} now={now} onRange={onRange} />
    </div>
  );
}

const PRESETS = ["today", "7d", "30d", "month"] as const;

function RangeMenu({ range, now, onRange }: { readonly range: Bounds; readonly now: Date; readonly onRange: (choice: RangeChoice) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState(dayValue(range.from));
  const [to, setTo] = useState(dayValue(range.to));
  useEffect(() => {
    if (!open) return;
    setFrom(dayValue(range.from));
    setTo(dayValue(range.to));
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !box.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open, range]);
  const backwards = from !== "" && to !== "" && from > to;
  const choose = (choice: RangeChoice) => {
    setOpen(false);
    onRange(choice);
  };
  return (
    <div className="rwrap" ref={box}>
      <button type="button" className="btn out" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="calendar" size={16} />
        <span>{range.label}</span>
        <Icon name="down" size={16} />
      </button>
      {open ? (
        <div className="rmenu" role="dialog" aria-label="Date range">
          {PRESETS.map((preset) => {
            const span = bounds({ range: preset }, now);
            return (
              <button key={preset} type="button" className="o" aria-pressed={range.kind === preset} onClick={() => choose({ range: preset === "30d" ? undefined : preset })}>
                {range.kind === preset ? <Icon name="check" size={16} /> : <span className="gap" />}
                <span>{RANGE_LABEL[preset]}</span>
                {preset === "today" ? null : <span className="kp">{span.span}</span>}
              </button>
            );
          })}
          <hr />
          <div className="rng">
            <label>
              From
              <input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={to} min={from || undefined} max={dayValue(now)} onChange={(event) => setTo(event.target.value)} />
            </label>
          </div>
          <div className="apply">
            {backwards ? <span className="err">The end is before the start.</span> : null}
            <button type="button" className="btn pri sm" disabled={!from || !to || backwards} onClick={() => choose({ range: "custom", from, to })}>
              Apply range
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type Chip = { readonly key: string; readonly label: string; readonly value: string; readonly clear?: () => void };

export function Chips({ chips, onClearAll }: { readonly chips: readonly Chip[]; readonly onClearAll: () => void }) {
  if (!chips.length) return null;
  return (
    <div className="lchips">
      {chips.map((chip) => (
        <span key={chip.key} className="lchip">
          {chip.label} <b>{chip.value}</b>
          {chip.clear ? (
            <button type="button" className="ib" aria-label={`Remove ${chip.label.toLowerCase()} filter`} onClick={chip.clear}>
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </span>
      ))}
      <button type="button" className="clr" onClick={onClearAll}>
        Clear all
      </button>
    </div>
  );
}

/* ---------- rows ---------- */

export function BadgeView({ badge }: { readonly badge: Badge }) {
  return (
    <span className={`bdg ${badge.tone === "plain" ? "" : badge.tone}`.trim()}>
      {badge.icon === "check" ? <Icon name="check" size={12} /> : badge.icon === "spin" ? <span className="spin" aria-hidden="true" /> : badge.icon === "dot" ? <span className="d" /> : null}
      {badge.label}
    </span>
  );
}

export const people = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;

export function SessionsHead({ one }: { readonly one?: boolean }) {
  return one ? (
    <div className="lr head" aria-hidden="true">
      <div>Started</div>
      <div className="dsk">Duration</div>
      <div className="dsk">People</div>
      <div className="dsk">Recording</div>
      <div className="dsk">Transcript</div>
      <div />
    </div>
  ) : (
    <div className="lr head" aria-hidden="true">
      <div>Call</div>
      <div />
      <div className="dsk">Started</div>
      <div className="dsk">Duration</div>
      <div className="dsk">People</div>
      <div className="dsk">Recording</div>
      <div className="dsk">Transcript</div>
      <div />
    </div>
  );
}

/** One past session. `one` is the call's own list, which leaves out the call. */
export function SessionRow({ row, one }: { readonly row: RowModel; readonly one?: boolean }) {
  const day = sessionDay(row.startedAt);
  const range = row.endedAt ? `${clock(row.startedAt)} to ${clock(row.endedAt)}` : `${clock(row.startedAt)}, ending`;
  const length = row.endedAt ? duration(row.startedAt, row.endedAt) : "";
  const recording = recordingBadge(row.video);
  const transcript = transcriptBadge(row.transcript, row.video);
  const mobileTranscript = row.video !== null && ["ready", "processing", "none"].includes(row.transcript) && recording.tone !== "bad" && recording.tone !== "mu";
  return (
    <div className="lr">
      <Link className="go" to="/dashboard/call/$spaceId/session/$episodeId" params={{ spaceId: row.spaceId, episodeId: row.episodeId }} aria-label={`${one ? "Session " : `${row.callName}, `}${day}, ${range}${length ? `, ${length}` : ""}, ${people(row.people)}, ${recording.label.toLowerCase()}`} />
      {one ? null : (
        <>
          <span className="cini" aria-hidden="true">
            {row.callName.trim().charAt(0).toUpperCase() || "C"}
          </span>
          <div className="nm">
            <b className="ell">{row.callName}</b>
          </div>
        </>
      )}
      <div className="dsk c2 num">
        {day}
        <small>{clock(row.startedAt)}</small>
      </div>
      <div className="dsk num">{length || "Ending"}</div>
      <div className="dsk pp num">
        <Icon name="users" size={14} />
        {row.people}
      </div>
      <div className="dsk">
        <BadgeView badge={recording} />
      </div>
      <div className="dsk tc">
        <BadgeView badge={transcript} />
      </div>
      <div className="mob mt num">
        {day}, {clock(row.startedAt)} · {length || "Ending"} · {people(row.people)}
      </div>
      <div className="mob bd">
        <BadgeView badge={recording} />
        {mobileTranscript ? <BadgeView badge={transcript} /> : null}
      </div>
      <div className="chev">
        <Icon name="right" size={16} />
      </div>
    </div>
  );
}

/* ---------- the next page, and what a list leaves out ---------- */

export function ListMore({
  scope,
  shown,
  total,
  noun,
  cursor,
  load,
  onLoaded,
}: {
  readonly scope: string;
  readonly shown: number;
  readonly total: number;
  readonly noun: string;
  readonly cursor: string | null;
  readonly load: (cursor: string) => Promise<SessionListDTO>;
  readonly onLoaded: (page: SessionListDTO) => void;
}) {
  const [busy, setBusy] = useState(false);
  const live = useRef(scope);
  live.current = scope;
  const toast = useToast();
  return (
    <div className="lmore">
      <span>
        Showing {shown} of {total} {noun}
      </span>
      {cursor ? (
        <button
          type="button"
          className="btn out"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            const asked = scope;
            load(cursor)
              .then(
                (page) => (live.current === asked ? onLoaded(page) : undefined),
                (error: unknown) => toast(errorMessage(error), { icon: "alert" }),
              )
              .finally(() => setBusy(false));
          }}
        >
          Show older {noun}
        </button>
      ) : null}
    </div>
  );
}

/** The scan behind a list is bounded. When a bound stops it, the oldest sessions are the ones missing, so the list says so. */
export function Cutoff({ truncated }: { readonly truncated: boolean }) {
  return truncated ? <div className="lcut">Chalk read the most recent calls only. Older sessions may be missing: choose a shorter date range or one call to see them.</div> : null;
}

export const refreshed = (fresh: SessionListDTO): Change<SessionListDTO> => new Change((current) => mergeFirstPage(current, fresh));

/** Time in calls: "21 h 05 min", "46 min", or a dash for none. */
export function TimeValue({ seconds }: { readonly seconds: number }) {
  const time = timeInCalls(seconds);
  if (!time) return "–";
  return time.hours ? (
    <>
      {time.hours} h <small>{String(time.minutes).padStart(2, "0")} min</small>
    </>
  ) : (
    <>
      {time.minutes} <small>min</small>
    </>
  );
}

/** A list read again for new filters keeps its old rows on screen, so the search box that asked for them stays mounted and focused. */
export function useShown(state: Load<SessionListDTO>): { readonly shown: SessionListDTO | null; readonly stale: boolean } {
  const last = useRef<SessionListDTO | null>(null);
  if (state.kind === "ready") last.current = state.data;
  if (state.kind === "error") last.current = null;
  return { shown: last.current, stale: state.kind === "loading" && last.current !== null };
}
