import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { trackSignals } from "./recording-evidence.mjs";
import { command } from "./runtime.mjs";

/**
 * The recorder's own output for each guest, from an operator-supplied command: the public API serves only the mixed MP4, and the
 * encrypted bundles sit in private storage behind a key that the proof never holds. The command runs once with
 * CHALK_PROOF_TRACKS_DIR (an empty private folder inside the run's encrypted evidence), CHALK_PROOF_RECORDING_ID and
 * CHALK_PROOF_PARTICIPANT_IDS (comma separated, in guest order). It must write that Recording's decrypted audio of each participant to
 * <participant id>.wav in the folder, and may leave the bundle and manifest there too; everything in the folder is kept as encrypted evidence.
 * Returns one signals object per guest, null for a guest without a file, or null when no command is configured.
 */
export async function recorderTracks(run, recordingId, participants, environment = process.env) {
  const hook = environment.CHALK_PROOF_RECORDER_TRACKS_COMMAND;
  if (!hook) return null;
  const directory = `${run.directory}/recorder-tracks`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await command("bash", ["-c", hook], {
    timeout: 600_000,
    signal: run.signal,
    env: { ...environment, CHALK_PROOF_TRACKS_DIR: directory, CHALK_PROOF_RECORDING_ID: recordingId, CHALK_PROOF_PARTICIPANT_IDS: participants.join(",") },
  });
  return Promise.all(participants.map((participant) => (existsSync(`${directory}/${participant}.wav`) ? trackSignals(`${directory}/${participant}.wav`) : null)));
}
