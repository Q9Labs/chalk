// Turns two capture runs into the verdict: layout findings the branch adds over master, and changed screens.

/** @typedef {{ check: string, key: string, detail: string }} Finding */

const id = (finding) => `${finding.check}|${finding.key}`;

/**
 * A finding blocks only when master's same frame lacks it. A frame master does not have (a new state) has no baseline,
 * so all of its findings count. A journey that failed to run always blocks, even when master's failed too: a journey that
 * never ran checked nothing, and a check that skips a journey in silence is how a bug goes unseen.
 * @param {{ frame: string, journey: string, size: string, scheme: string, label: string, findings: Finding[] }[]} headFrames
 * @param {{ frame: string, findings: Finding[] }[]} baseFrames
 */
export function newFindings(headFrames, baseFrames) {
  const base = new Map(baseFrames.map((frame) => [frame.frame, new Set(frame.findings.map(id))]));
  const baseJourneyFailed = new Set(baseFrames.filter((frame) => frame.step === -1).map((frame) => frame.frame.replace(/\.error$/u, "")));
  const result = [];
  for (const frame of headFrames) {
    const known = base.get(frame.frame);
    for (const finding of frame.findings) {
      if (finding.check !== "journey-failed" && known?.has(id(finding))) continue;
      if (!known && baseJourneyFailed.has(frame.frame.replace(/\.\d+$/u, ""))) continue;
      result.push({ frame: frame.frame, journey: frame.journey, size: frame.size, scheme: frame.scheme, label: frame.label, ...finding });
    }
  }
  return result;
}

/** Findings that master has and the branch fixed, for the comment's good news. */
function fixedFindings(headFrames, baseFrames) {
  return newFindings(baseFrames, headFrames).length;
}
