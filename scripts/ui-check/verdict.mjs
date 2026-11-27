// Turns two capture runs into the verdict: layout findings the branch adds over master, and changed screens.

/** @typedef {{ check: string, key: string, detail: string }} Finding */

const id = (finding) => `${finding.check}|${finding.key}`;

/**
 * Findings a reviewer looked at and accepted, one per frame, each with the reason. A frame or finding not named here still blocks.
 * @type {{ frame: string, check: string, key: string, reason: string }[]}
 */
const ACCEPTED_FINDINGS = [
  {
    frame: "settings@tablet-dark.1",
    check: "control-covered",
    key: "button[Video tile for Alex]",
    reason: "The open microphone menu lies over the self-view tile at tablet width. The dock lost its Present button (Present moved into the Share menu), so it re-centered and the menu moved 26px right.",
  },
];

const accepted = (frame, finding) => ACCEPTED_FINDINGS.some((entry) => entry.frame === frame && entry.check === finding.check && entry.key === finding.key);

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
      if (accepted(frame.frame, finding)) continue;
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
