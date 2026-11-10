import { bounds, cycleSeconds, flashSeconds, markerHz, markerSeconds, phraseDelaySeconds, slotSeconds } from "./call-script.mjs";
import { check, command, waitFor } from "./runtime.mjs";

const startLeadMs = 3000;
const mutedGuest = 1;
const standingGuest = 2;
const holdSeconds = 12;
const stopAfterHoldSeconds = 10;
// How long a restarted capture node may take to rejoin before the next round of markers.
const restartSettleMs = 30_000;

/** Starts one round of scripted turns on the given pages from a single wall-clock instant and returns each guest's reported loop start. */
async function startRound(run, pages, guestList, cycles) {
  const loopStartMs = Date.now() + startLeadMs;
  const options = { loopStartMs, slotSeconds, cycleSeconds, cycles, markerHz, markerSeconds, phraseDelaySeconds, flashSeconds };
  const reports = await Promise.all(guestList.map((guest) => pages[guest].evaluate((value) => window.proofStartTurns(value), options)));
  const guests = guestList.map((guest, index) => {
    const { loopStartMs: startMs, lateByMs, contextState } = reports[index];
    const skewMs = Math.round(startMs - loopStartMs);
    console.log(`Guest ${guest + 1} loop starts at ${new Date(startMs).toISOString()} (${skewMs >= 0 ? "+" : ""}${skewMs} ms from the shared start)`);
    check(contextState === "running" && lateByMs === 0, `Guest ${guest + 1}'s audio clock was ${contextState} and ${lateByMs} ms late for the shared start`);
    check(Math.abs(skewMs) <= bounds.loopSkewMs, `Guest ${guest + 1}'s loop started ${skewMs} ms from the shared start, beyond ${bounds.loopSkewMs} ms`);
    return { guest, startMs };
  });
  await run.wait(loopStartMs + cycles * cycleSeconds * 1000 - Date.now());
  return { guests, cycles };
}

async function shareScreen(pages) {
  await pages[0].evaluate(() => window.proofClient.media.setScreenShareEnabled(true));
  await waitFor("screen share enabled", () => pages[0].evaluate(() => window.proofClient.getSnapshot().media.screenShare.state === "enabled"));
}

/**
 * Plays the scripted call on guests that are already live and recorded, and returns the script that call-script.mjs judges.
 * 1. Two cycles of turns (marker beep + camera flash, then a phrase) from one shared start.
 * 2. Guest 2 holds a tone and mutes, while guest 1 shares its screen (the browser's fake display) while holding its own tone, because the Recording has no shared-screen audio.
 * 3. Optionally one capture-node restart (CHALK_PROOF_CAPTURE_RESTART_COMMAND), then one more round without the muted guest.
 * 4. Guest 3 holds a tone while the host stops the Recording.
 */
export async function playCall(run, guests, phraseSeconds, restartCommand) {
  const pages = guests.pages;
  const script = { anchorGuest: 0, phraseSeconds, rounds: [await startRound(run, pages, [0, 1, 2], 2)] };

  console.log("Guest 2 holds a tone and guest 1 holds a tone and shares its screen");
  const holdStartMs = await pages[mutedGuest].evaluate((hz) => window.proofHoldTone(hz), markerHz[mutedGuest]);
  await pages[0].evaluate((hz) => window.proofHoldTone(hz), markerHz[0]);
  await shareScreen(pages);
  const screenStartMs = Date.now();
  await run.wait(holdSeconds * 1000);
  const muteMs = Date.now();
  await pages[mutedGuest].evaluate(() => window.proofClient.media.setMicrophoneEnabled(false));
  await run.wait(holdSeconds * 1000);
  const screenStopMs = Date.now();
  await pages[0].evaluate(() => window.proofClient.media.setScreenShareEnabled(false));
  await Promise.all([pages[0], pages[mutedGuest]].map((page) => page.evaluate(() => window.proofHoldStop())));
  Object.assign(script, { hold: { guest: mutedGuest, startMs: holdStartMs, muteMs }, screen: { startMs: screenStartMs, stopMs: screenStopMs } });

  if (restartCommand) {
    console.log("Restarting the capture node");
    const startMs = Date.now();
    await command("bash", ["-c", restartCommand], { timeout: 300_000, signal: run.signal });
    await run.wait(restartSettleMs);
    const current = await pages[0].evaluate(() => window.proofClient.getSnapshot().recording.current);
    const resumed = current?.status === "recording";
    const round = await startRound(run, pages, [0, standingGuest], 1);
    script.rounds.push(round);
    script.restart = { startMs, roundStartMs: Math.min(...round.guests.map((entry) => entry.startMs)), resumed };
  } else {
    script.restart = null;
    console.log("Capture-node restart skipped: CHALK_PROOF_CAPTURE_RESTART_COMMAND is not set");
  }

  console.log("Guest 3 holds a tone while the host stops the Recording");
  const standingStartMs = await pages[standingGuest].evaluate((hz) => window.proofHoldTone(hz), markerHz[standingGuest]);
  await run.wait(stopAfterHoldSeconds * 1000);
  const stopMs = Date.now();
  await pages[0].evaluate(() => window.proofClient.recording.stop());
  await run.wait(bounds.endMs + 3000);
  await pages[standingGuest].evaluate(() => window.proofHoldStop());
  script.stop = { guest: standingGuest, holdStartMs: standingStartMs, stopMs };
  return script;
}
