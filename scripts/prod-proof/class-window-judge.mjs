// Pure judgement of one class from its samples. A sample is one reading of every guest's inbound RTP
// (the rows `stats(pages)` returns), taken at `at` ms after the class window opened.
// Camera and screen count as flowing only when the viewer's decoder advanced in the same window.

/** Rows of this kind whose decoder advanced since the previous sample: the streams that really flowed. */
export function advancedStreams(previousRows, currentRows, matches) {
  return currentRows.filter((row) => {
    if (!matches(row)) return false;
    const before = previousRows.find((earlier) => earlier.id === row.id && earlier.connection === row.connection);
    return before !== undefined && row.framesDecoded > before.framesDecoded;
  }).length;
}

const isCamera = (row) => row.type === "inbound-rtp" && row.kind === "video" && row.source === "camera";
const isScreen = (row) => row.type === "inbound-rtp" && row.kind === "video" && row.source === "screen";

/**
 * judgeClass({ samples, participants, sharer, rampMs, shareStartupMs })
 *
 * A camera window passes when every guest decoded a camera stream from each of the other participants.
 * A screen window passes when every viewer (not the sharer) decoded the screen stream, and only windows
 * that start at least `shareStartupMs` into a share stretch count, so a stretch's first frame cannot fail it.
 */
export function judgeClass({ samples, participants = 3, sharer = 0, rampMs = 120_000, shareStartupMs = 30_000 }) {
  const cameraWindows = [];
  const screenWindows = [];
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (current.at < rampMs) continue;
    const cameraOk = current.guests.every(
      (rows, guest) => advancedStreams(previous.guests[guest], rows, isCamera) >= participants - 1,
    );
    cameraWindows.push({ at: current.at, ok: cameraOk });
    const sameStretch = current.shareOn && previous.shareOn && current.shareStartedAt === previous.shareStartedAt;
    if (sameStretch && current.at - current.shareStartedAt >= shareStartupMs) {
      const screenOk = current.guests.every(
        (rows, guest) => guest === sharer || advancedStreams(previous.guests[guest], rows, isScreen) >= 1,
      );
      screenWindows.push({ at: current.at, ok: screenOk });
    }
  }
  const summarize = (windows) => ({
    passed: windows.filter((window) => window.ok).length,
    total: windows.length,
    firstFailureAt: windows.find((window) => !window.ok)?.at ?? null,
  });
  const camera = summarize(cameraWindows);
  const screen = summarize(screenWindows);
  return {
    camera,
    screen,
    pass: camera.total > 0 && camera.passed === camera.total && screen.total > 0 && screen.passed === screen.total,
  };
}

/** The run's verdict: every class must pass, and a class with no samples fails rather than passing empty. */
export function judgeRun(verdicts) {
  const failed = verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.class);
  return { classes: verdicts.length, passed: verdicts.length - failed.length, failed, pass: verdicts.length > 0 && failed.length === 0 };
}
