// fallow-ignore-file complexity -- the rules branch on every kind of evidence; the unmute tests cover each branch, which the CRAP estimate cannot see.
import { clock, short } from "./call.mjs";
import { cause, finding } from "./finding.mjs";
import { attr, flag, number, participantHash } from "./rows.mjs";

/**
 * The client's legs of an unmute, which the client telemetry lane writes with an unmute id that joins the node's rows. Each names the
 * event that carries the leg. A leg whose event is not set, or whose rows are absent, is listed as missing data and never guessed.
 */
const CLIENT_LEGS = [
  { name: "click to the node's acknowledgement", event: undefined },
  { name: "receiver playout", event: undefined },
];

/** The nearest-rank percentile of a list of milliseconds, or undefined for an empty list. */
export function percentile(values, share) {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];
}

const cache = new WeakMap();
const SUBSCRIPTION_EVENTS = ["sfu.subscription.started", "sfu.subscription.resumed", "sfu.subscription.paused", "sfu.subscription.stopped"];

/** Connections whose audio subscription to the publisher's source was running at `time`: the last start, resume, pause or stop of each decides. */
function subscribersAt(rows, publisher, source, time) {
  const last = new Map();
  for (const row of rows) {
    const named = SUBSCRIPTION_EVENTS.includes(row.event) && row.time <= time && attr(row, "publisher_id") !== undefined && participantHash(String(attr(row, "publisher_id"))) === publisher;
    if (named && attr(row, "source") === source && (attr(row, "media_kind") ?? "audio") === "audio") last.set(`${row.connection}/${attr(row, "mid")}`, row);
  }
  return [...last.values()].filter((row) => row.event === "sfu.subscription.started" || row.event === "sfu.subscription.resumed");
}

/**
 * The node's share of every unmute of a microphone, from the node's own clock. One unmute is the publisher's `sfu.publication.held` with
 * `held=false`, the `sfu.unmute.first_voiced` that follows on the same publication (same Participant, generation, source and `unmute_seq`),
 * and one `sfu.unmute.first_forwarded` for each subscriber that was sent the packet. A forwarded row names the publisher and not its
 * generation, so it belongs to the latest unmute of that publisher, source and number that began before it.
 */
export function unmutesOf(call) {
  if (cache.has(call)) return cache.get(call);
  const rows = call.rows.filter((row) => row.source === "sfu");
  const heldRows = rows.filter((row) => row.event === "sfu.publication.held");
  const unmutes = heldRows
    .filter((row) => flag(row, "held") === false)
    .map((held) => {
      const same = (row) => row.participant === held.participant && number(row, "generation") === number(held, "generation") && attr(row, "source") === attr(held, "source") && number(row, "unmute_seq") === number(held, "unmute_seq");
      return { publisher: held.participant, generation: number(held, "generation"), source: attr(held, "source"), seq: number(held, "unmute_seq"), at: held.time, held, voiced: rows.find((row) => row.event === "sfu.unmute.first_voiced" && same(row) && row.time >= held.time), forwards: [] };
    });
  for (const row of rows.filter((candidate) => candidate.event === "sfu.unmute.first_forwarded")) {
    const publisher = attr(row, "publisher_id") === undefined ? undefined : participantHash(String(attr(row, "publisher_id")));
    const owner = unmutes.filter((unmute) => unmute.publisher === publisher && unmute.source === attr(row, "source") && unmute.seq === number(row, "unmute_seq") && unmute.at <= row.time).sort((a, b) => b.at - a.at)[0];
    owner?.forwards.push({ subscriber: row.participant, connection: row.connection, forwardMs: number(row, "since_voiced_ms"), totalMs: number(row, "since_unmute_ms"), row });
  }
  for (const unmute of unmutes) {
    const forwarded = new Set(unmute.forwards.map((forward) => forward.connection));
    const expected = unmute.voiced ? subscribersAt(rows, unmute.publisher, unmute.source, unmute.voiced.time) : [];
    unmute.unforwarded = [...new Set(expected.map((row) => row.connection))].filter((connection) => !forwarded.has(connection));
    unmute.voicedMs = unmute.voiced ? number(unmute.voiced, "since_unmute_ms") : undefined;
  }
  const mutes = heldRows.filter((row) => flag(row, "held") === true);
  const legs = {
    heldToVoiced: unmutes.map((unmute) => unmute.voicedMs).filter(Number.isFinite),
    voicedToForwarded: unmutes.flatMap((unmute) => unmute.forwards.map((forward) => forward.forwardMs)).filter(Number.isFinite),
    heldToForwarded: unmutes.flatMap((unmute) => unmute.forwards.map((forward) => forward.totalMs)).filter(Number.isFinite),
  };
  const report = {
    unmutes,
    mutes,
    legs,
    p95: Object.fromEntries(Object.entries(legs).map(([name, values]) => [name, percentile(values, 0.95)])),
    missingClientLegs: CLIENT_LEGS.filter((leg) => !leg.event || !call.rows.some((row) => row.event === leg.event)).map((leg) => leg.name),
  };
  cache.set(call, report);
  return report;
}

/** The unmutes whose node total went past the budget, worst first, each with the leg that took the time. */
export function overBudget(report, thresholds) {
  return report.unmutes.flatMap((unmute) => unmute.forwards.filter((forward) => forward.totalMs > thresholds.unmute_audible_p95_ms).map((forward) => ({ unmute, forward }))).sort((a, b) => b.forward.totalMs - a.forward.totalMs);
}

const ms = (value) => `${Math.round(value)} ms`;

/** One line for the summary: the node's legs at p95 against the budget, and the mute side the node cannot judge alone. */
export function unmuteLines(report, thresholds) {
  const lines = [];
  const budget = thresholds.unmute_audible_p95_ms;
  if (report.unmutes.length > 0) {
    const { heldToVoiced, voicedToForwarded, heldToForwarded } = report.p95;
    const verdict = heldToForwarded === undefined ? "no subscriber was sent a voiced packet, so the node's total is unknown" : heldToForwarded > budget ? `OVER the ${ms(budget)} budget` : `within the ${ms(budget)} budget`;
    const part = (value, name, count) => (value === undefined ? `${name} not measured` : `${name} ${ms(value)} (${count})`);
    lines.push(
      `Unmute, the node's legs at p95 over ${report.unmutes.length} unmutes: ${part(heldToVoiced, "held to first voiced", `${report.legs.heldToVoiced.length} unmutes`)}, ${part(voicedToForwarded, "first voiced to first forwarded", `${report.legs.voicedToForwarded.length} subscribers`)}, ${part(heldToForwarded, "held to first forwarded", `${report.legs.heldToForwarded.length} subscribers`)}: ${verdict}`,
    );
    for (const { unmute, forward } of overBudget(report, thresholds).slice(0, 5)) {
      lines.push(
        `  over budget: Participant ${short(unmute.publisher)} ${unmute.source} unmute ${unmute.seq} at ${clock(unmute.at)} UTC took ${ms(forward.totalMs)} to reach Participant ${short(forward.subscriber)} (held to voiced ${ms(unmute.voicedMs ?? NaN)}, voiced to forwarded ${ms(forward.forwardMs ?? NaN)})`,
      );
    }
    for (const unmute of report.unmutes.filter((candidate) => candidate.unforwarded.length > 0).slice(0, 3)) {
      lines.push(`  not forwarded: Participant ${short(unmute.publisher)} ${unmute.source} unmute ${unmute.seq} at ${clock(unmute.at)} UTC reached the node but ${unmute.unforwarded.length} subscribed connections got no first_forwarded line`);
    }
  }
  if (report.mutes.length > 0) lines.push(`Mute: the node applied ${report.mutes.length} mutes; the ${ms(thresholds.unmute_visible_p95_ms)} p95 budget for others seeing the state needs the client's click time, which is missing data`);
  return lines;
}

/** Missing data about unmutes and mutes: the client legs, and the subscribers that were sent no first-forwarded line. */
export function unmuteGaps(report) {
  if (report.unmutes.length === 0 && report.mutes.length === 0) return [];
  const missing = report.missingClientLegs;
  const gaps = missing.length > 0 ? [{ source: "client", blocks: false, what: `no client rows carry the unmute legs (${missing.join(", ")}), so the budgets for seeing a mute and hearing an unmute are judged on the node's share alone` }] : [];
  const lost = report.unmutes.reduce((count, unmute) => count + unmute.unforwarded.length, 0);
  if (lost > 0) gaps.push({ source: "sfu", blocks: false, what: `${lost} subscribed connections got no sfu.unmute.first_forwarded line for an unmute they were subscribed for: the subscription was paused, the packet could not be sent, or the export lost the line` });
  return gaps;
}

/**
 * The call's p95 for hearing an unmute against its budget. The node's total is a part of what the listener waits for, so a total over the
 * budget proves the call missed it. The first leg also holds the time the speaker took to start speaking, so the finding says which leg took the time.
 */
export function unmuteFindings(call, thresholds) {
  const report = unmutesOf(call);
  const total = report.p95.heldToForwarded;
  if (total === undefined || total <= thresholds.unmute_audible_p95_ms) return [];
  const slow = overBudget(report, thresholds);
  const worstOne = slow[0];
  const forwarding = report.p95.voicedToForwarded;
  const voicing = report.p95.heldToVoiced;
  const node = forwarding !== undefined && forwarding >= (voicing ?? 0);
  const notes = [
    `${slow.length} of ${report.legs.heldToForwarded.length} first-forwarded lines were over ${ms(thresholds.unmute_audible_p95_ms)}; the worst was ${ms(worstOne.forward.totalMs)}`,
    ...(node ? [] : [`held to first voiced (${ms(voicing ?? NaN)} at p95) includes the time the speaker took to start speaking, so it is not all the node's`]),
    ...(report.missingClientLegs.length > 0 ? [`the client legs (${report.missingClientLegs.join(", ")}) are missing data and would add to this`] : []),
  ];
  const text = node
    ? `the node's own forwarding leg took ${ms(forwarding)} at p95, from receiving the first voiced packet to sending it, longer than the ${ms(voicing ?? NaN)} from the unmute to that packet`
    : `the time from the node applying the unmute to the first voiced packet taking ${ms(voicing ?? NaN)} at p95 dominates; the node forwarded it in ${forwarding === undefined ? "an unmeasured time" : `${ms(forwarding)} at p95`}`;
  return [
    finding(
      "unmute_slow",
      worstOne.unmute.publisher,
      worstOne.unmute.at,
      worstOne.unmute.at + worstOne.forward.totalMs,
      `was heard ${ms(total)} after unmuting at p95 on the node alone, over the ${ms(thresholds.unmute_audible_p95_ms)} budget`,
      cause(text, node ? "forwarding" : "publishing", node ? "SFU" : "unknown", notes),
      slow.flatMap(({ unmute, forward }) => [unmute.held, ...(unmute.voiced ? [unmute.voiced] : []), forward.row]),
    ),
  ];
}
