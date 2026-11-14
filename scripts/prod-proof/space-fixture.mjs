export const manualPolicy = { recording: "manual", transcription: "on_demand" };

// The one body every proof sends to create a Space. `mediaPlane` is left out when a proof lets the deployment decide, because the public API refuses chalk_sfu.
export function spacePayload({ name, slug, policy = manualPolicy, metadata, mediaPlane }) {
  return {
    name,
    slug,
    ...(metadata && { metadata }),
    ...(mediaPlane && { media_plane: mediaPlane }),
    recording_policy: policy.recording,
    transcription_policy: policy.transcription,
    default_episode_duration_seconds: 1800,
    maximum_episode_duration_seconds: 1800,
    linger_window_seconds: 60,
    admission_policy: { mode: "open" },
  };
}
