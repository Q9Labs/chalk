import { Link } from "@tanstack/react-router";

import { clock, duration, sessionDay } from "../../lib/dashboard/format";
import { recordingBadge, transcriptBadge, type Badge, type RowModel } from "../../lib/dashboard/lists";
import { Icon } from "../site/Icon";

/* A call's own list of past sessions, and the pills a session's recording and transcript show. */

/* ---------- rows ---------- */

export function BadgeView({ badge }: { readonly badge: Badge }) {
  return (
    <span className={`bdg ${badge.tone === "plain" ? "" : badge.tone}`.trim()}>
      {badge.icon === "check" ? <Icon name="check" size={12} /> : badge.icon === "spin" ? <span className="spin" aria-hidden="true" /> : badge.icon === "dot" ? <span className="d" /> : null}
      {badge.label}
    </span>
  );
}

const people = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;

export function SessionsHead() {
  return (
    <div className="lr head" aria-hidden="true">
      <div>Started</div>
      <div className="dsk">Duration</div>
      <div className="dsk">People</div>
      <div className="dsk">Recording</div>
      <div className="dsk">Transcript</div>
      <div />
    </div>
  );
}

/** One past session in its call's list. */
export function SessionRow({ row }: { readonly row: RowModel }) {
  const day = sessionDay(row.startedAt);
  const range = row.endedAt ? `${clock(row.startedAt)} to ${clock(row.endedAt)}` : `${clock(row.startedAt)}, ending`;
  const length = row.endedAt ? duration(row.startedAt, row.endedAt) : "";
  const recording = recordingBadge(row.video);
  const transcript = transcriptBadge(row.transcript, row.video);
  const mobileTranscript = row.video !== null && ["ready", "processing", "none"].includes(row.transcript) && recording.tone !== "bad" && recording.tone !== "mu";
  return (
    <div className="lr">
      <Link className="go" to="/dashboard/call/$spaceId/session/$episodeId" params={{ spaceId: row.spaceId, episodeId: row.episodeId }} aria-label={`Session ${day}, ${range}${length ? `, ${length}` : ""}, ${people(row.people)}, ${recording.label.toLowerCase()}`} />
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
      <div className="dsk">
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
