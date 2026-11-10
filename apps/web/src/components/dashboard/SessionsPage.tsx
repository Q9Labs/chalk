import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, type ReactNode } from "react";

import type { SessionListDTO } from "../../lib/dashboard/contracts";
import { errorMessage, readPage } from "../../lib/dashboard/client";
import { appendPage, bounds, rowModel, sessionsQueryOf } from "../../lib/dashboard/lists";
import type { SessionsSearch } from "../../lib/dashboard/search";
import { Icon } from "../site/Icon";
import { useLoad } from "./AppShell";
import { useShown, Chips, Cutoff, FilterNav, ListMore, ListTools, SessionRow, SessionsHead, TimeValue, type Chip, type NavItem, type RangeChoice } from "./ListParts";
import { ErrorPanel, Sk, SkeletonRows } from "./kit";
import { Page, Stat } from "./Page";

const SHOW: readonly { readonly show: NonNullable<SessionsSearch["show"]>; readonly label: string; readonly icon: "calendar" | "film" | "file" | "recOff" }[] = [
  { show: "all", label: "All sessions", icon: "calendar" },
  { show: "recording", label: "With recording", icon: "film" },
  { show: "transcript", label: "With transcript", icon: "file" },
  { show: "none", label: "Without recording", icon: "recOff" },
];

export function SessionsPage({ search }: { readonly search: SessionsSearch }) {
  const navigate = useNavigate();
  const router = useRouter();
  const now = useMemo(() => new Date(), []);
  const query = sessionsQueryOf(search, now);
  const { state, reload, update } = useLoad(() => readPage("sessions", query), JSON.stringify(query));
  const range = bounds(search, now);
  const show = search.show ?? "all";
  const filtered = show !== "all" || search.spaceId !== undefined || search.q !== undefined;

  const to = "/dashboard/sessions" as const;
  const link = (next: SessionsSearch) => ({ href: router.buildLocation({ to, search: next }).href, go: () => void navigate({ to, search: next }) });
  const setSearch = useCallback((q: string | undefined) => void navigate({ to, search: (previous) => ({ ...previous, q }), replace: true }), [navigate]);
  const setRange = (choice: RangeChoice) => void navigate({ to, search: (previous) => ({ ...previous, range: choice.range, from: choice.from, to: choice.to }) });

  const { shown, stale } = useShown(state);
  const callName = (id: string) => shown?.calls.find((call) => call.id === id)?.name ?? shown?.rows.find((row) => row.spaceId === id)?.callName ?? "This call";
  const keep = { q: search.q, range: search.range, from: search.from, to: search.to };
  const showItems: NavItem[] = SHOW.map((item) => ({ key: item.show, label: item.label, icon: item.icon, on: show === item.show, ...link({ ...search, show: item.show === "all" ? undefined : item.show }) }));
  const callItems: NavItem[] = (shown?.calls ?? []).map((call) => ({ key: call.id, label: call.name, icon: "users", hideOnPhone: true, on: search.spaceId === call.id, ...link({ ...search, spaceId: search.spaceId === call.id ? undefined : call.id }) }));
  const nav = <FilterNav label="Filter sessions" groups={[{ cap: "Show", items: showItems }, ...(callItems.length ? [{ cap: "Call", items: callItems }] : [])]} />;

  const chips: Chip[] = [
    ...(show !== "all" ? [{ key: "show", label: "Show", value: SHOW.find((item) => item.show === show)?.label ?? show, clear: () => link({ ...search, show: undefined }).go() }] : []),
    ...(search.spaceId ? [{ key: "call", label: "Call", value: callName(search.spaceId), clear: () => link({ ...search, spaceId: undefined }).go() }] : []),
    ...(search.q ? [{ key: "q", label: "Call name", value: search.q, clear: () => link({ ...search, q: undefined }).go() }] : []),
    ...(filtered ? [{ key: "date", label: "Date", value: range.label, clear: range.kind === "30d" ? undefined : () => link({ ...search, range: undefined, from: undefined, to: undefined }).go() }] : []),
  ];

  const frame = (children: ReactNode) => (
    <Page
      icon="calendar"
      title="Sessions"
      intro="Each time people met in one of your calls, with who came, its recording and its transcript."
      nav={nav}
      end={
        <Link className="btn out end" to="/dashboard">
          <Icon name="plus" size={16} />
          Start a call
        </Link>
      }
    >
      {children}
    </Page>
  );

  if (state.kind === "error") return frame(<ErrorPanel title="Couldn’t load your sessions" detail={errorMessage(state.error)} onRetry={reload} />);
  if (shown === null)
    return frame(
      <>
        <div className="card stats" aria-busy="true">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="stat">
              <Sk width="90px" height={12} />
              <Sk width="60px" height={24} />
              <Sk width="110px" height={12} />
            </div>
          ))}
        </div>
        <section className="panel card">
          <div className="ph">
            <Sk width="140px" height={18} />
          </div>
          <SkeletonRows count={5} />
        </section>
      </>,
    );

  const { totals, rows } = shown;
  const percent = totals.sessions ? Math.round((totals.recorded / totals.sessions) * 100) : 0;
  const whole = !filtered;
  return frame(
    <>
      <div className="card stats" role="group" aria-label="Summary">
        <Stat icon="calendar" label="Sessions" value={String(totals.sessions)}>
          {filtered ? "Matching your filters" : totals.sessions ? range.label : "Nothing yet"}
        </Stat>
        <Stat icon="clock" label="Time in calls" value={<TimeValue seconds={totals.seconds} />}>
          {!totals.sessions ? "No calls yet" : whole ? "Across all calls" : "In these sessions"}
        </Stat>
        <Stat
          icon="film"
          label="Recorded"
          value={
            <>
              {totals.recorded} <small>of {totals.sessions}</small>
            </>
          }
        >
          {!totals.sessions ? "–" : totals.recorded ? `${percent}% of sessions` : "Off or expired"}
        </Stat>
        <Stat icon="file" label="Transcripts" value={String(totals.transcripts)}>
          {!totals.sessions ? "–" : totals.transcripts ? "Ready to read" : "None ready"}
        </Stat>
      </div>
      <section className={stale ? "panel card stale" : "panel card"} aria-busy={stale || undefined} aria-labelledby="sessions-title">
        <div className="ph">
          <Icon name="calendar" size={18} />
          <h2 id="sessions-title">Past sessions</h2>
          {totals.sessions ? <span className="pill">{totals.sessions}</span> : null}
        </div>
        <>
          <ListTools q={search.q} placeholder="Search by call name" range={range} now={now} onSearch={setSearch} onRange={setRange} />
          <Chips chips={chips} onClearAll={() => void navigate({ to, search: keep.range ? { range: keep.range, from: keep.from, to: keep.to } : {} })} />
        </>
        {rows.length ? (
          <>
            <div className="slist ses">
              <SessionsHead />
              {rows.map((row) => (
                <SessionRow key={row.episode.id} row={rowModel(row)} />
              ))}
            </div>
            <Cutoff truncated={shown.truncated} />
            <ListMore
              scope={JSON.stringify(query)}
              shown={rows.length}
              total={totals.sessions}
              noun="sessions"
              cursor={shown.nextCursor}
              load={(cursor) => readPage("sessions", { ...query, cursor })}
              onLoaded={(page: SessionListDTO) => update((current) => appendPage(current, page), { refresh: false })}
            />
          </>
        ) : filtered || range.kind !== "30d" ? (
          <div className="blank tall">
            <span className="tile">
              <Icon name="search" size={20} />
            </span>
            <b>No sessions match</b>
            <p>
              {search.q ? `Nothing ${range.kind === "custom" ? `from ${range.span}` : range.label.toLowerCase()} has “${search.q}” in its call name.` : `Nothing ${range.kind === "custom" ? `from ${range.span}` : range.label.toLowerCase()} matches these filters.`} Try another word or a wider date
              range.
            </p>
            <button type="button" className="btn out" onClick={() => void navigate({ to, search: {} })}>
              Clear filters
            </button>
          </div>
        ) : (
          <div className="blank tall">
            <span className="tile">
              <Icon name="calendar" size={20} />
            </span>
            <b>No sessions yet</b>
            <p>When people join one of your calls, each session shows up here with who came, its recording and its transcript.</p>
            <div className="bacts">
              <Link className="btn pri lg" to="/dashboard">
                <Icon name="plus" size={16} />
                Start a call
              </Link>
            </div>
          </div>
        )}
      </section>
    </>,
  );
}
