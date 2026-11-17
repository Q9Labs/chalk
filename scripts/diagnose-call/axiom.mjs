// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/** Axiom's query client for the diagnosis: one query, its rows, and whether the row cap cut it off. */
export const ROW_CAP = 5000;
const ID = /^[\w.:-]{1,128}$/u;

/** An id may go into a query only when it is made of the characters ids are made of. */
export function quote(id) {
  if (!ID.test(id)) throw new Error(`refusing to put "${id.slice(0, 20)}" in a query: it is not an id`);
  return `'${id}'`;
}

/** Splits a list of ids so one query never names more than `size` of them. */
export function chunks(ids, size = 100) {
  const parts = [];
  for (let at = 0; at < ids.length; at += size) parts.push(ids.slice(at, at + size));
  return parts;
}

export async function axiom({ token, org, dataset, apl, start, end, signal }, fetchImpl) {
  const response = await fetchImpl("https://api.axiom.co/v1/datasets/_apl?format=legacy", {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(org ? { "x-axiom-org-id": org } : {}) },
    body: JSON.stringify({ apl: `['${dataset}'] | ${apl} | take ${ROW_CAP}`, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() }),
  });
  if (!response.ok) throw new Error(`Axiom answered HTTP ${response.status} for dataset ${dataset}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  const rows = (body.matches ?? []).map((match) => ({ _time: match._time, _rowId: match._rowId, ...match.data }));
  return { rows, truncated: rows.length >= ROW_CAP };
}

/**
 * Runs a query that names optional fields. Axiom refuses a field the dataset has never seen, which is what a dataset
 * looks like before the build that logs the field is deployed; drop that field, say so, and ask again.
 */
export async function withFields(fields, build, run, onAbsent) {
  const present = new Set(fields);
  for (let attempt = 0; attempt <= fields.length; attempt += 1) {
    try {
      return await run(build(present));
    } catch (error) {
      const absent = /invalid field: \\?"attributes\.(\w+)\\?"/u.exec(error.message)?.[1];
      if (!absent || !present.delete(absent)) throw error;
      onAbsent(absent);
    }
  }
  return { rows: [], truncated: false };
}
