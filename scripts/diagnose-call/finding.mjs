// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { cite } from "./call.mjs";

/**
 * A finding says what a Participant lived through, at which stage of the media path it went wrong, on whose side, and which rows
 * prove it. `side` is one of client, API, Sync, SFU, recorder or unknown: unknown is the honest answer when the rows show
 * a failure but not who caused it. The first party named in `cause` (viewer, publisher) says whose client it was.
 */
export const cause = (text, stage, side, notes = []) => ({ text, stage, side, notes });
export const finding = (kind, participant, from, to, experience, why, rows, benign = false) => ({ kind, participant, from, to, experience, cause: why.text, stage: why.stage, side: why.side, notes: why.notes, benign, proof: cite(rows) });
