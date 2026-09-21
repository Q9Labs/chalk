import type { RecordingPolicy, TranscriptionPolicy } from "../../lib/dashboard-api";

type SpaceArtifactPolicyFieldsProps = {
  readonly recordingPolicy: RecordingPolicy;
  readonly transcriptionPolicy: TranscriptionPolicy;
  readonly transcriptionCeiling?: string | null;
  readonly onRecordingPolicyChange: (policy: RecordingPolicy) => void;
  readonly onTranscriptionPolicyChange: (policy: TranscriptionPolicy) => void;
  readonly prefix: string;
};

export function SpaceArtifactPolicyFields({ recordingPolicy, transcriptionPolicy, transcriptionCeiling, onRecordingPolicyChange, onTranscriptionPolicyChange, prefix }: SpaceArtifactPolicyFieldsProps) {
  const ceiling = readTranscriptionPolicy(transcriptionCeiling);
  const limited = ceiling !== undefined && transcriptionRank(transcriptionPolicy) > transcriptionRank(ceiling);
  const missingCapture = transcriptionNeedsCapture(recordingPolicy, transcriptionPolicy);

  return (
    <>
      <fieldset>
        <legend>Capture for future Episodes</legend>
        <label htmlFor={`${prefix}-recording-policy`}>Capture</label>
        <select id={`${prefix}-recording-policy`} value={recordingPolicy} onChange={(event) => onRecordingPolicyChange(event.target.value as RecordingPolicy)}>
          <option value="disabled">Off</option>
          <option value="manual">Manual</option>
          <option value="automatic">Automatic</option>
        </select>
        <small>{recordingPolicyDescription(recordingPolicy)} Capture stores source media; it does not create a Video Export.</small>
      </fieldset>

      <fieldset>
        <legend>Transcript for future Episodes</legend>
        <label htmlFor={`${prefix}-transcription-policy`}>Transcript</label>
        <select id={`${prefix}-transcription-policy`} value={transcriptionPolicy} onChange={(event) => onTranscriptionPolicyChange(event.target.value as TranscriptionPolicy)}>
          <option value="disabled">Off</option>
          <option value="on_demand">On demand</option>
          <option value="automatic">Automatic</option>
        </select>
        <small>{transcriptionPolicyDescription(transcriptionPolicy)}</small>
        {limited ? (
          <p className="fixture-note" role="status">
            {transcriptionPolicyLabel(transcriptionPolicy)} transcription is limited to {transcriptionPolicyLabel(ceiling!)} by this Tenant’s operator-managed ceiling. Future Episodes will use that limit until an operator changes it.
          </p>
        ) : null}
        {missingCapture ? (
          <p className="fixture-note" role="alert">
            Transcription requires Capture. Turn on Capture or turn off Transcript before saving. Capture stores source media; it does not create a Video Export.
          </p>
        ) : null}
      </fieldset>

      <p className="fixture-note">These choices apply to Episodes that start after you save. They do not change an active Episode, past Episode, or its immutable snapshot.</p>
      <p className="fixture-note">To transcribe every captured Episode, choose Automatic for both Capture and Transcript.</p>
    </>
  );
}

export function transcriptionNeedsCapture(recordingPolicy: RecordingPolicy, transcriptionPolicy: TranscriptionPolicy): boolean {
  return recordingPolicy === "disabled" && transcriptionPolicy !== "disabled";
}

export function readRecordingPolicy(value: string | null | undefined): RecordingPolicy {
  if (value === "manual" || value === "automatic") return value;
  return "disabled";
}

function readTranscriptionPolicy(value: string | null | undefined): TranscriptionPolicy | undefined {
  if (value === "disabled" || value === "on_demand" || value === "automatic") return value;
  return undefined;
}

export function transcriptionPolicyOrDisabled(value: string | null | undefined): TranscriptionPolicy {
  return readTranscriptionPolicy(value) ?? "disabled";
}

function recordingPolicyDescription(policy: RecordingPolicy): string {
  if (policy === "manual") return "Capture starts only when an Episode explicitly starts it.";
  if (policy === "automatic") return "Capture starts automatically for each Episode.";
  return "No media is captured.";
}

function transcriptionPolicyDescription(policy: TranscriptionPolicy): string {
  if (policy === "on_demand") return "A transcript is created from captured audio only when requested.";
  if (policy === "automatic") return "A transcript is created automatically from captured audio.";
  return "No transcript is created.";
}

function transcriptionPolicyLabel(policy: TranscriptionPolicy): string {
  if (policy === "on_demand") return "On demand";
  if (policy === "automatic") return "Automatic";
  return "Off";
}

function transcriptionRank(policy: TranscriptionPolicy): number {
  if (policy === "automatic") return 2;
  if (policy === "on_demand") return 1;
  return 0;
}
