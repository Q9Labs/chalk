// @ts-check
/**
 * LOCAL STUB of C1's handle seam (branch obs/foundation-c1 owns the prefix table and both functions). Keep the two exported names
 * and signatures; when C1 lands, replace this file's body with a re-export of C1's module and delete the table below.
 *
 * Contract the CLI relies on:
 * - `formatHandle(kind, id)` returns the full display handle: the kind's prefix, `_`, and the canonical id lowercased with dashes
 *   removed. Handles are display and lookup syntax only; rows keep their canonical ids.
 * - `parseHandle(text)` returns `{ kind, fragment }` for any text that starts with a known prefix and `_`, where `fragment` may be
 *   a prefix of the id (a short handle), or null for anything else. Resolving a fragment to ids is the reader's job, and an
 *   ambiguous fragment returns candidates.
 *
 * Kinds this lane needs that the plan's prefix table does not list: `finding` uses `f_` (the plan's table says `F-xxxx`, its CLI
 * samples say `f_71c2`) and `evidence` uses `ev_` for an observation's event id. C1 decides both.
 */

/** @type {Readonly<Record<string, string>>} */
const PREFIX = Object.freeze({
  tenant: "ten",
  space: "spc",
  episode: "ep",
  participant: "pt",
  user: "usr",
  agent: "agt",
  device: "dev",
  client_session: "cs",
  media_connection: "mc",
  sync_connection: "sc",
  journey: "jr",
  recording: "rec",
  job: "job",
  webhook_delivery: "whd",
  finding: "f",
  evidence: "ev",
});
const KIND = new Map(Object.entries(PREFIX).map(([kind, prefix]) => [prefix, kind]));

/**
 * @param {string} kind
 * @param {string} id
 */
export function formatHandle(kind, id) {
  const prefix = PREFIX[kind];
  if (prefix === undefined) throw new TypeError(`no handle prefix for kind ${JSON.stringify(kind)}`);
  return `${prefix}_${id.toLowerCase().replaceAll("-", "")}`;
}

/**
 * @param {string} text
 * @returns {{ kind: string, fragment: string } | null}
 */
export function parseHandle(text) {
  const match = /^([a-z]+)_([0-9a-z]+)$/u.exec(text.trim().toLowerCase());
  if (!match) return null;
  const kind = KIND.get(match[1]);
  return kind === undefined ? null : { kind, fragment: match[2] };
}
