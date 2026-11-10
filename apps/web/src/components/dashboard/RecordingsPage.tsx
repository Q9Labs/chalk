import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { SessionListDTO, SessionRowDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, readPage } from "../../lib/dashboard/client";
import { clock, duration, sessionDay } from "../../lib/dashboard/format";
import { appendPage, bounds, recordingsQueryOf, rowModel, VIDEO_BADGE } from "../../lib/dashboard/lists";
import type { RecordingsSearch } from "../../lib/dashboard/search";
import { VIDEO, videoGroup, videoState, type VideoGroup } from "../../lib/dashboard/recording";
import { Icon } from "../site/Icon";
import { useLoad } from "./AppShell";
import { useShown, BadgeView, Chips, Cutoff, FilterNav, ListMore, ListTools, people, refreshed, TimeValue, type Chip, type NavItem, type RangeChoice } from "./ListParts";
import { Page, Stat } from "./Page";
import { RecordingPlayer } from "./RecordingPlayer";
import { Dialog, ErrorPanel, Sk, SkeletonRows, useCopy, useIntentKeys, useToast } from "./kit";

const STATUS: readonly { readonly status: VideoGroup | undefined; readonly label: string; readonly dot: "ok" | "pr" | "wn" | "bd" | "" | undefined }[] = [
  { status: undefined, label: "All recordings", dot: undefined },
  { status: "ready", label: "Ready", dot: "ok" },
  { status: "processing", label: "Processing", dot: "pr" },
  { status: "prepare", label: "Not prepared", dot: "wn" },
  { status: "failed", label: "Failed", dot: "bd" },
  { status: "expired", label: "Expired", dot: "" },
];

/** A page polls this often while a recording on it is still being made; each read scans the calls again, so it stays slow. */
const POLL_MS = 30_000;

export function RecordingsPage({ search }: { readonly search: RecordingsSearch }) {
  const navigate = useNavigate();
  const router = useRouter();
  const now = useMemo(() => new Date(), []);
  const query = recordingsQueryOf(search, now);
  const { state, reload, update } = useLoad(() => readPage("recordings", query), JSON.stringify(query), {
    visibility: "status",
    interval: (data) => (data.totals.video.processing || data.rows.some((row) => row.recording && videoGroup(row.recording.video) === "processing") ? POLL_MS : undefined),
    read: async () => refreshed(await readPage("recordings", query)),
  });
  const [deleting, setDeleting] = useState<SessionRowDTO | null>(null);
  const range = bounds(search, now);
  const status = search.status;
  const filtered = status !== undefined || search.spaceId !== undefined || search.q !== undefined;

  const to = "/dashboard/recordings" as const;
  const link = (next: RecordingsSearch) => ({ href: router.buildLocation({ to, search: { ...next, play: undefined } }).href, go: () => void navigate({ to, search: { ...next, play: undefined } }) });
  const setSearch = useCallback((q: string | undefined) => void navigate({ to, search: (previous) => ({ ...previous, q }), replace: true }), [navigate]);
  const setRange = (choice: RangeChoice) => void navigate({ to, search: (previous) => ({ ...previous, range: choice.range, from: choice.from, to: choice.to }) });
  const play = (recordingId: string | undefined) => void navigate({ to, search: (previous) => ({ ...previous, play: recordingId }), replace: recordingId === undefined });

  const { shown, stale } = useShown(state);
  const playing = search.play === undefined ? undefined : shown?.rows.find((row) => row.recording?.id === search.play);
  // A link to a recording that this page doesn't list can't say which session it belongs to, so the page drops it.
  useEffect(() => {
    if (search.play !== undefined && shown && !playing) play(undefined);
  });

  const callName = (id: string) => shown?.calls.find((call) => call.id === id)?.name ?? shown?.rows.find((row) => row.spaceId === id)?.callName ?? "This call";
  const statusItems: NavItem[] = STATUS.map((item) => ({ key: item.status ?? "all", label: item.label, ...(item.dot === undefined ? { icon: "film" as const } : { dot: item.dot }), on: status === item.status, ...link({ ...search, status: item.status }) }));
  const callItems: NavItem[] = (shown?.calls ?? []).map((call) => ({ key: call.id, label: call.name, icon: "users", hideOnPhone: true, on: search.spaceId === call.id, ...link({ ...search, spaceId: search.spaceId === call.id ? undefined : call.id }) }));
  const nav = <FilterNav label="Filter recordings" groups={[{ cap: "Status", items: statusItems }, ...(callItems.length ? [{ cap: "Call", items: callItems }] : [])]} />;
  const chips: Chip[] = [
    ...(status ? [{ key: "status", label: "Status", value: STATUS.find((item) => item.status === status)?.label ?? status, clear: () => link({ ...search, status: undefined }).go() }] : []),
    ...(search.spaceId ? [{ key: "call", label: "Call", value: callName(search.spaceId), clear: () => link({ ...search, spaceId: undefined }).go() }] : []),
    ...(search.q ? [{ key: "q", label: "Call name", value: search.q, clear: () => link({ ...search, q: undefined }).go() }] : []),
    ...(filtered ? [{ key: "date", label: "Date", value: range.label, clear: range.kind === "30d" ? undefined : () => link({ ...search, range: undefined, from: undefined, to: undefined }).go() }] : []),
  ];

  const frame = (children: ReactNode) => (
    <Page
      icon="film"
      title="Recordings"
      intro="Every recorded call in this account. Play one to watch it and read its transcript."
      nav={nav}
      end={
        <Link className="btn out end" to="/dashboard/developer" hash="calls">
          <Icon name="sliders" size={16} />
          Recording settings
        </Link>
      }
    >
      {children}
    </Page>
  );

  if (state.kind === "error") return frame(<ErrorPanel title="Couldn’t load your recordings" detail={errorMessage(state.error)} onRetry={reload} />);
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
  const attention = totals.video.failed + totals.video.prepare;
  const processing = totals.video.processing;
  const emptyTotals = totals.sessions === 0;
  return frame(
    <>
      <div className="card stats" role="group" aria-label="Summary">
        <Stat icon="film" label="Recordings" value={String(totals.sessions)}>
          {filtered ? "Matching your filters" : emptyTotals ? "Nothing recorded yet" : range.label}
        </Stat>
        <Stat icon="clock" label="Recorded time" value={<TimeValue seconds={totals.seconds} />}>
          {emptyTotals ? "No calls yet" : filtered ? "In these recordings" : "Across all calls"}
        </Stat>
        <Stat icon="check" label="Ready" value={String(totals.video.ready)}>
          {emptyTotals ? "–" : totals.video.ready ? "Ready to watch" : "None ready"}
        </Stat>
        <Stat icon="alert" label="Needs attention" value={String(attention)}>
          {attention ? (
            <>
              {totals.video.failed ? (
                <span className="pill bad">
                  <span className="d" />
                  {totals.video.failed} failed
                </span>
              ) : null}
              {totals.video.prepare ? <span className="pill">{totals.video.prepare} not prepared</span> : null}
            </>
          ) : (
            "All clear"
          )}
        </Stat>
      </div>
      <section className={stale ? "panel card stale" : "panel card"} aria-busy={stale || undefined} aria-labelledby="recordings-title">
        <div className="ph">
          <Icon name="film" size={18} />
          <h2 id="recordings-title">All recordings</h2>
          {totals.sessions ? <span className="pill">{totals.sessions}</span> : null}
        </div>
        <>
          <ListTools q={search.q} placeholder="Search by call name" range={range} now={now} onSearch={setSearch} onRange={setRange} />
          {processing ? (
            <div className="lnote" role="status">
              <span className="spin" aria-hidden="true" />
              <span>
                <b>{processing === 1 ? "1 recording is processing." : `${processing} recordings are processing.`}</b> This page updates by itself, so you can leave it. Most are ready within a few minutes.
              </span>
            </div>
          ) : null}
          <Chips chips={chips} onClearAll={() => void navigate({ to, search: search.range ? { range: search.range, from: search.from, to: search.to } : {} })} />
        </>
        {rows.length ? (
          <>
            <div className="slist rec">
              <div className="lr head" aria-hidden="true">
                <div>Recording</div>
                <div />
                <div className="dsk">Date</div>
                <div className="dsk">Length</div>
                <div className="dsk">Status</div>
                <div />
              </div>
              {rows.map((row) => (
                <RecordingRow key={row.episode.id} row={row} onPlay={play} onDelete={setDeleting} onChanged={(video) => update((current) => withVideo(current, row.episode.id, video), { refresh: false })} />
              ))}
            </div>
            <Cutoff truncated={shown.truncated} />
            <ListMore
              scope={JSON.stringify(query)}
              shown={rows.length}
              total={totals.sessions}
              noun="recordings"
              cursor={shown.nextCursor}
              load={(cursor) => readPage("recordings", { ...query, cursor })}
              onLoaded={(page: SessionListDTO) => update((current) => appendPage(current, page), { refresh: false })}
            />
          </>
        ) : filtered || range.kind !== "30d" ? (
          <div className="blank tall">
            <span className="tile">
              <Icon name="search" size={20} />
            </span>
            <b>No recordings match</b>
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
              <Icon name="film" size={20} />
            </span>
            <b>No recordings yet</b>
            <p>Turn recording on in a call. When it ends, the recording shows up here with its transcript. Recording videos on demand needs one extra step: press Prepare video.</p>
            <div className="bacts">
              <Link className="btn pri lg" to="/dashboard">
                <Icon name="plus" size={16} />
                Start a call
              </Link>
              <Link className="btn out lg" to="/dashboard/developer" hash="calls">
                <Icon name="sliders" size={16} />
                Recording settings
              </Link>
            </div>
          </div>
        )}
      </section>
      {playing ? <RecordingPlayer row={rowModel(playing)} onClose={() => play(undefined)} /> : null}
      {deleting ? (
        <DeleteTranscript
          row={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const id = deleting.episode.id;
            setDeleting(null);
            update((current) => withoutTranscript(current, id));
          }}
        />
      ) : null}
    </>,
  );
}

/** A prepare or retry answer moves its row to the new video state at once; the next read confirms it. */
function withVideo(list: SessionListDTO, episodeId: string, video: SessionRowDTO["recording"] & object): SessionListDTO {
  return { ...list, rows: list.rows.map((row) => (row.episode.id === episodeId && row.recording ? { ...row, recording: video } : row)) };
}

function withoutTranscript(list: SessionListDTO, episodeId: string): SessionListDTO {
  return { ...list, rows: list.rows.map((row) => (row.episode.id === episodeId ? { ...row, transcript: "none", transcriptIds: [] } : row)) };
}

/* ---------- one row ---------- */

function Sub({ row, recording }: { readonly row: SessionRowDTO; readonly recording: NonNullable<SessionRowDTO["recording"]> }) {
  const group = videoGroup(recording.video);
  if (group === "ready")
    return (
      <span className="u">
        {people(row.participantCount)} ·
        <Icon name="cc" size={12} />
        {row.transcript === "ready" ? "Transcript ready" : row.transcript === "processing" ? "Transcript processing" : "No transcript yet"}
      </span>
    );
  if (group === "processing") return <span className="u pend">You can leave this page</span>;
  if (group === "prepare")
    return (
      <>
        <span className="u hide-m">Prepare the video to watch or download it</span>
        <span className="u mob">Not prepared yet</span>
      </>
    );
  if (group === "failed") return <span className="u bad">{VIDEO[recording.video].title}</span>;
  return <span className="u">No longer available</span>;
}

function RecordingRow({ row, onPlay, onDelete, onChanged }: { readonly row: SessionRowDTO; readonly onPlay: (recordingId: string) => void; readonly onDelete: (row: SessionRowDTO) => void; readonly onChanged: (recording: NonNullable<SessionRowDTO["recording"]>) => void }) {
  const { recording } = row;
  if (!recording) return null;
  const group = videoGroup(recording.video);
  const length = row.episode.endedAt ? duration(row.episode.startedAt, row.episode.endedAt) : "Ending";
  const day = sessionDay(row.episode.startedAt);
  return (
    <div className="lr">
      <span className={`thumb${group === "failed" || group === "expired" ? " dim" : ""}`} aria-hidden="true">
        <Icon name={group === "ready" ? "play" : "film"} size={16} />
        {group === "processing" ? <span className="bar" /> : null}
      </span>
      <div className="nm">
        <b className="ell">{row.callName}</b>
        <Sub row={row} recording={recording} />
      </div>
      <div className="dsk c2 num">
        {day}
        <small>{clock(row.episode.startedAt)}</small>
      </div>
      <div className="dsk num">{length}</div>
      <div className="mob mt num">
        {day}, {clock(row.episode.startedAt)} · {length}
      </div>
      <div className="st">
        <BadgeView badge={VIDEO_BADGE[group]} />
      </div>
      <RowActions row={row} recording={recording} onPlay={onPlay} onDelete={onDelete} onChanged={onChanged} />
    </div>
  );
}

function RowActions({
  row,
  recording,
  onPlay,
  onDelete,
  onChanged,
}: {
  readonly row: SessionRowDTO;
  readonly recording: NonNullable<SessionRowDTO["recording"]>;
  readonly onPlay: (recordingId: string) => void;
  readonly onDelete: (row: SessionRowDTO) => void;
  readonly onChanged: (recording: NonNullable<SessionRowDTO["recording"]>) => void;
}) {
  const toast = useToast();
  const intents = useIntentKeys();
  const { copied, copy } = useCopy("Link copied. It opens for people signed in to this account.");
  const [busy, setBusy] = useState(false);
  const ids = { spaceId: row.spaceId, episodeId: row.episode.id };
  const action = VIDEO[recording.video].action;
  const link = (
    <button type="button" className={copied ? "ib ok" : "ib"} aria-label={copied ? "Copied" : "Copy link"} data-tip onClick={() => void copy(`${window.location.origin}/dashboard/call/${row.spaceId}/session/${row.episode.id}`)}>
      <Icon name={copied ? "check" : "link"} />
    </button>
  );
  const trash = row.transcriptIds.length ? (
    <button type="button" className="ib dg" aria-label="Delete transcript" data-tip onClick={() => onDelete(row)}>
      <Icon name="trash" />
    </button>
  ) : null;

  async function download() {
    try {
      window.location.assign((await act("past-session", { action: "recording-url", ...ids, recordingId: recording.id, download: true })).url);
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    }
  }
  async function prepare() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await act("past-session", { action: "export-recording", ...ids, recordingId: recording.id, idempotencyKey: intents.key(`export:${recording.id}`) });
      intents.done(`export:${recording.id}`);
      onChanged({ ...recording, video: videoState(result.recording), failureMessage: result.recording.failureMessage });
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="racts">
      {action === "play" ? (
        <>
          <button type="button" className="btn pri sm" onClick={() => onPlay(recording.id)}>
            <Icon name="play" size={14} />
            Play
          </button>
          <button type="button" className="ib" aria-label="Download recording" data-tip onClick={() => void download()}>
            <Icon name="dl" />
          </button>
          {link}
        </>
      ) : null}
      {action === "prepare" || action === "retry" ? (
        <>
          <button type="button" className="btn out sm" aria-busy={busy || undefined} disabled={busy} onClick={() => void prepare()}>
            {busy ? <span className="spin" aria-hidden="true" /> : <Icon name={action === "retry" ? "retry" : "film"} size={14} />}
            {action === "retry" ? "Retry" : "Prepare video"}
          </button>
          {action === "prepare" ? link : null}
        </>
      ) : null}
      {trash}
    </div>
  );
}

/* ---------- delete ---------- */

function DeleteTranscript({ row, onClose, onDeleted }: { readonly row: SessionRowDTO; readonly onClose: () => void; readonly onDeleted: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      for (const transcriptId of row.transcriptIds) await act("past-session", { action: "delete-transcript", spaceId: row.spaceId, episodeId: row.episode.id, transcriptId });
      toast("Transcript deleted.", { icon: "check" });
      onDeleted();
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
      setBusy(false);
    }
  }
  return (
    <Dialog
      alert
      icon="trash"
      title="Delete this transcript?"
      description="The transcript is deleted for good. The recording and the session stay."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn out lg" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn dz lg" aria-busy={busy || undefined} disabled={busy} onClick={() => void remove()}>
            {busy ? <span className="spin" aria-hidden="true" /> : <Icon name="trash" size={16} />}
            Delete transcript
          </button>
        </>
      }
    >
      <div className="victim">
        <span className="thumb dim" aria-hidden="true">
          <Icon name="file" size={16} />
        </span>
        <div>
          <b className="ell">{row.callName}</b>
          <span className="u num">
            {sessionDay(row.episode.startedAt)}, {clock(row.episode.startedAt)}
          </span>
        </div>
      </div>
      <div className="warnbox">
        <Icon name="alert" size={16} />
        <span>You can’t undo this.</span>
      </div>
    </Dialog>
  );
}
