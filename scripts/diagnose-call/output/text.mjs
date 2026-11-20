// @ts-check
/**
 * The compact line grammar. Every line starts with a keyword or a handle, so an agent can grep it:
 *
 *   <view> <scope> outcome= coverage= checked=c/e asof= rules=     line 1, always
 *   anchor=<utc> local=<tenant time> ...                            the one time anchor
 *   via: <query> as <what matched>                                   how a lookup resolved, when it did
 *   <records>                                                        paged by --limit, --cursor and --budget
 *   gap: ...                                                         never paged, and present exactly when coverage is not complete
 *   more: N omitted by limit|budget                                  output left out on purpose, never a source read incompletely
 *   next: diagnose ...                                               commands that drill down
 *
 * Times are relative (`+07:10`) only in an Episode, attempt or job detail; aggregate views print tenant-local clock times.
 */
import { formatHandle } from "./handle.mjs";
import { partyText } from "./format.mjs";
import { approxTokens } from "./page.mjs";

/** @typedef {import("./views.mjs").View} View */
/** @typedef {import("./views.mjs").Head} Head */
/** @typedef {(value: unknown) => string} Handle */

/**
 * A finalized view's handles are strings already; an unfinalized record (for `--budget`) still holds Refs, shown at minimum length.
 * @type {Handle}
 */
const handle = (value) => {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "$h" in value && "id" in value) {
    const full = formatHandle(String(value.$h), String(value.id));
    return full.slice(0, full.indexOf("_") + 5);
  }
  return String(value);
};

/** Approximate tokens of one record as text, for `--budget`. @param {object} record */
export const measureRecord = (record) => approxTokens(recordLines(record, handle).join("\n"));

/** @param {View} view @returns {string} */
export function renderText(view) {
  const complete = view.head.coverage?.state === "complete";
  if (view.head.coverage !== null && complete !== (view.gaps.length === 0)) throw new Error(`view ${view.view}: coverage ${view.head.coverage.state} with ${view.gaps.length} gap lines`);
  const lines = [headLine(view.head)];
  if (view.anchor) lines.push(anchorLine(view.anchor, view.view === "episode" || view.view === "attempt" || view.view === "job" || view.view === "evidence"));
  if (view.via) lines.push(`via: ${JSON.stringify(view.via.query)} as ${view.via.as}`);
  for (const record of view.records) lines.push(...recordLines(record, handle));
  for (const gap of view.gaps) lines.push(gapLine(gap));
  if (view.page && view.page.omitted > 0) lines.push(`more: ${view.page.omitted} omitted by ${view.page.by} (limit=${view.page.limit})`);
  for (const command of view.next) lines.push(`next: ${command}`);
  return `${lines.join("\n")}\n`;
}

/** @param {Head} head */
function headLine(head) {
  const scope = head.scope;
  const words = [head.view];
  if (head.view === "episode" || head.view === "attempt" || head.view === "job") words.push(String(scope.item), `tenant=${scope.tenant}`);
  else if (head.view === "evidence") words.push(String(scope.finding), String(scope.code), partyText(/** @type {any} */ (scope.party), handle), `of=${scope.item}`);
  else if (head.view === "day") words.push(String(scope.tenant), String(scope.date), ...(scope.symptom ? [`symptom=${scope.symptom}`] : []));
  else if (head.view === "resolve") words.push(JSON.stringify(scope.query), `matched=${scope.matched}`);
  else {
    for (const [key, value] of Object.entries(scope)) {
      const shown = typeof value === "object" && value !== null ? partyText(/** @type {any} */ (value), handle) : String(value);
      words.push(key === "who" || key === "code" ? shown : `${key}=${shown}`);
    }
  }
  if (head.outcome !== null) words.push(`outcome=${head.outcome}`);
  if (head.coverage !== null) {
    const counts = head.coverage.missing.filter((entry) => entry.includes("="));
    const areas = head.coverage.missing.filter((entry) => !entry.includes("="));
    words.push(`coverage=${head.coverage.state}${areas.length > 0 ? `(${areas.join(",")})` : ""}`);
    if (head.checked !== null) words.push(`checked=${head.checked}/${head.eligible}`);
    words.push(...counts);
  }
  words.push(`asof=${head.asof}`);
  if (head.rules !== null) words.push(`rules=${head.rules}`);
  return words.join(" ");
}

/** @param {import("./views.mjs").Anchor} anchor @param {boolean} detail relative-time views print the offset, not the zone name */
function anchorLine(anchor, detail) {
  const { utc, local, tz, ...extra } = anchor;
  const words = [`anchor=${utc}`, `local=${local}`];
  for (const [key, value] of Object.entries(extra)) words.push(`${key}=${handle(value)}`);
  if (!detail) words.push(`tz=${tz}`);
  return words.join(" ");
}

/** @param {readonly unknown[]} list */
const cite = (list) => `[${list.map(handle).join(",")}]`;

/** @param {string} name @param {unknown} value */
const opt = (name, value) => (value === null || value === undefined ? [] : [`${name}=${value}`]);
/** @param {string} text @param {string | null | undefined} when */
const at = (text, when) => (when ? `${text} ${when}` : text);

/**
 * One text form per record type. Each takes the record, the handle formatter, and a party formatter built on it.
 * Records are the view's JSON wire shape (`View.records` is `object[]`), so they are read loosely here on purpose: the goldens pin
 * every field each renderer reads, and an unknown type throws.
 * @type {Record<string, (r: Record<string, any>, h: Handle, party: (value: any) => string) => string[]>}
 */
const RECORD_LINES = {
  finding: (r, h, party) => {
    const words = [h(r.f), r.outcome, r.code, ...(r.item ? [h(r.item)] : []), ...(r.party ? [party(r.party)] : []), r.when, ...opt("hop", r.hop), ...opt("upstream", r.upstream), ...(r.ev ? [`ev=${h(r.ev)}`] : []), ...(r.retained ? ["retained"] : [])];
    const lines = [words.join(" ")];
    for (const fact of r.facts ?? []) lines.push(`fact: ${at(fact.text, fact.when)} ${fact.absent ? "[proven absent]" : cite(fact.ev)}`);
    if (r.hypothesis) lines.push(`hypothesis: ${r.hypothesis.text}`);
    return lines;
  },
  disagree: (r, h, party) => {
    if (r.f) return [`disagree ${h(r.f)} ${r.about} ${party(r.party)}: ${r.why}`];
    return [`disagree ${r.about} ${party(r.party)} ${r.when} ${r.claims.map((/** @type {any} */ c) => `${c.source}:${c.claim}${cite([c.ev])}`).join(" ")} independent=${r.independent ? "yes" : "no"}`];
  },
  report: (r, h, party) => [`report ${h(r.ev)} ${party(r.party)} ${r.when} ${JSON.stringify(r.text)} explained_by=${r.explained_by ? h(r.explained_by) : "none"}`],
  group: (r, h) => [[r.code, r.outcome, `episodes=${r.episodes}`, ...opt("people", r.people), ...r.items.map(h), ...(r.more > 0 ? [`+${r.more}`] : [])].join(" ")],
  item: (r, h) => {
    const missing = r.coverage.missing.length > 0 ? `(${r.coverage.missing.join(",")})` : "";
    return [[r.state, h(r.item), r.when, `outcome=${r.outcome}`, `coverage=${r.coverage.state}${missing}`, ...(r.codes?.length > 0 ? [`codes=${r.codes.join(",")}`] : []), ...opt("was", r.was)].join(" ")];
  },
  candidate: (r, h) => [["cand", h(r.ref), r.kind, JSON.stringify(r.label), ...opt("tenant", r.tenant), ...opt("as", r.meaning), ...(r.when ? [r.when] : [])].join(" ")],
  expected: (r) => [`expected: ${r.text}`],
  observed: (r) => [`observed: ${r.text} ${r.when}`],
  fact: (r) => [`fact: ${at(r.text, r.when)} ${r.absent ? `[proven absent: ${r.absent}]` : cite(r.ev)}`],
  hypothesis: (r) => [r.text === null ? "hypothesis: none, the evidence does not attribute a cause" : `hypothesis: ${r.text}; falsified by ${r.falsified_by}`],
  witness: (r, h) => {
    const value = Object.entries(r.value)
      .map(([k, v]) => ` ${k}=${v}`)
      .join("");
    return [`witness: ${h(r.ev)} ${r.fact} ${r.source} origin=${r.origin} claim=${r.claim} ${r.when}${value}`, `row: ${r.row}`];
  },
  watermark: (r, h, party) => [`watermark: ${r.source} ${party(r.party)} complete_to=${r.complete_to ?? "unread"} evidence_gaps=${r.gaps} build=${JSON.stringify(r.build)}`],
  query: (r) => [`query: ${r.fact}: ${r.text}`],
  falsify: (r) => [...(r.absence ? [`falsify absence: ${r.absence}`] : []), ...(r.attribution ? [`falsify attribution: ${r.attribution}`] : [])],
  retained: (r) => [`retained: proven in bundle ${r.from_bundle}; its rows may be gone, the proof copy above is what was seen`],
  independence: (r) => [`independence: ${r.witnesses} witnesses from ${r.origins} independent origins`],
};

/**
 * The lines of one record. Exported so `--budget` can measure a record before handles are final.
 * @param {Record<string, any>} r
 * @param {Handle} h
 * @returns {string[]}
 */
export function recordLines(r, h) {
  const lines = Object.hasOwn(RECORD_LINES, r.t) ? RECORD_LINES[r.t] : null;
  if (lines === null) throw new TypeError(`no text form for record ${r.t}`);
  return lines(r, h, (value) => partyText(value, h));
}

/** @param {Record<string, any>} gap */
function gapLine(gap) {
  if (gap.t === "item") return ["gap:", gap.state, handle(gap.item), gap.when, ...(gap.missing.length > 0 ? [`missing=${gap.missing.join(",")}`] : []), ...(gap.was ? [`was=${gap.was}`] : [])].join(" ");
  const parties = gap.all ? [`all ${gap.all} seats`] : (gap.parties ?? []).map((/** @type {any} */ p) => partyText(p, handle));
  return `gap: ${[gap.code, ...(gap.ev ? [handle(gap.ev)] : []), ...parties].join(" ")}: ${gap.why}`;
}
