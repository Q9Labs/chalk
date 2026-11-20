import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../../../../../scripts/diagnose-call/proof/catalogue.mjs";
import { judgeFixture, ruleResult } from "../../../../../scripts/diagnose-call/proof/rows.mjs";
import { unwrapRow } from "../../../../../scripts/diagnose-call/live/world.mjs";
import { MediaDeviceSelection } from "../space-client/media-device-selection";
import type { TelemetryDraft } from "../telemetry/types";
import { AudioReceiveHealth } from "./audio-receive-health";
import type { CloudflareSFURemoteTrack } from "./types";

type Fixture = Parameters<typeof judgeFixture>[0];
type Code = "audio.not_heard" | "audio.cant_hear";

function fixture(code: Code, healthy: boolean): Fixture {
  return JSON.parse(readFileSync(new URL(`../../../../../observability/fixtures/${code}/${healthy ? "healthy" : "positive"}.json`, import.meta.url), "utf8"));
}

function judge(input: Fixture, code: Code) {
  const { verdict, dropped } = judgeFixture(input, CATALOGUE, code);
  expect(dropped).toEqual([]);
  return { ...ruleResult(verdict, code), rows: verdict.findings.filter((finding) => finding.code === code) };
}

// Live time and identity arrive in the persisted envelope, not in the audio payload.
function withCaptured(input: Fixture, index: number, draft: TelemetryDraft): Fixture {
  const row = input.rows[index];
  if (!row) throw new Error("No fixture row for the observation");
  const { audio_observation: _, audio_sample_ms: _sample, audio_track_key: _track, audio_peer_id: _peer, event: _event, ...envelope } = row;
  return { ...input, rows: input.rows.map((existing, at) => (at === index ? unwrapRow({ ...envelope, event: "sdk.telemetry", ...draft }) : existing)) };
}

function liveMic() {
  return { kind: "audio", id: "local-track", readyState: "live", muted: false, enabled: true } as MediaStreamTrack;
}

describe("audio.not_heard", () => {
  it.each([false, true])("judges the selected microphone's actual capture result (healthy=%s)", async (healthy) => {
    const drafts: TelemetryDraft[] = [];
    const stream = { getTracks: () => [liveMic()] } as MediaStream;
    const denial = new DOMException("private device failure", "NotAllowedError");
    const selection = new MediaDeviceSelection(
      {
        getUserMedia: async (constraints) => {
          expect(constraints.audio).toEqual({ deviceId: { exact: "private-device" } });
          if (!healthy) throw denial;
          return stream;
        },
        getDisplayMedia: async () => stream,
        releaseTrack: () => {},
      },
      { record: (draft) => drafts.push(draft) },
    );
    selection.selectCapture("microphone", "private-device");
    const capture = selection.getUserMedia({ audio: true, video: false });
    if (healthy) await expect(capture).resolves.toBe(stream);
    else await expect(capture).rejects.toBe(denial);

    expect(drafts).toEqual([
      { type: "audio_observed", audio_observation: "selected_input" },
      { type: "audio_observed", audio_observation: healthy ? "capture_live" : "capture_denied" },
    ]);
    const code = "audio.not_heard";
    const input = withCaptured(withCaptured(fixture(code, healthy), 0, drafts[0]!), 1, drafts[1]!);
    const result = judge(input, code);
    if (!healthy) {
      expect(result.rows).toMatchObject([{ hop: "mic_permission", module: "sdk.audio.capture", subject: `pt:${input.rows[1]!.participant_id}` }]);
      return;
    }
    expect(result.checked).toBe(result.eligible);
    expect(result.findings).toBe(0);
    for (const index of [1, 2, 3]) {
      const missing = judge({ ...input, rows: input.rows.filter((_, at) => at !== index) }, code);
      expect(missing.checked).toBeLessThan(missing.eligible);
    }
  });
});

describe("audio.cant_hear", () => {
  it.each([false, true])("judges real playback observation when inbound bytes advance (healthy=%s)", async (healthy) => {
    const code = "audio.cant_hear";
    const input = fixture(code, healthy);
    const sender = input.rows[2]?.audio_peer_id;
    if (typeof sender !== "string") throw new Error("Fixture needs a remote Participant");
    const publication: CloudflareSFURemoteTrack = { source: "microphone", participantId: sender, publicationId: "connection|mic-a", track: liveMic() };
    const drafts: TelemetryDraft[] = [];
    let now = 0;
    let bytes = 0;
    const connection = {
      getStats: async () => new Map([["rtp", { type: "inbound-rtp", kind: "audio", trackIdentifier: publication.track.id, bytesReceived: bytes }]]),
    } as unknown as RTCPeerConnection;
    const audio = Object.assign(new EventTarget(), { paused: !healthy, currentTime: 0, srcObject: { getTracks: () => [publication.track] } }) as unknown as HTMLAudioElement;
    const health = new AudioReceiveHealth({
      now: () => now,
      setInterval,
      clearInterval,
      connection: () => connection,
      tracks: () => [publication],
      onEvent: () => {},
      audioTelemetry: { record: (draft) => drafts.push(draft) },
    });
    try {
      health.roster([publication]);
      health.pullSucceeded([publication.publicationId]);
      health.observeAudioElement(publication.track, audio).played(healthy ? undefined : new DOMException("private policy detail", "NotAllowedError"));
      await health.sample();
      expect(drafts.map((draft) => draft.audio_observation)).toEqual(["subscribed"]);
      now += 5000;
      bytes += 4096;
      audio.currentTime += healthy ? 1 : 0;
      await health.sample();

      expect(drafts.map((draft) => draft.audio_observation)).toEqual(["subscribed", healthy ? "playing" : "autoplay_blocked"]);
      const observed = withCaptured(withCaptured(input, 1, drafts[0]!), 2, drafts[1]!);
      const result = judge(observed, code);
      if (healthy) {
        expect(result.checked).toBe(result.eligible);
        expect(result.findings).toBe(0);
        const lostPlayback = judge({ ...observed, rows: observed.rows.filter((_, index) => index !== 2) }, code);
        expect(lostPlayback.checked).toBeLessThan(lostPlayback.eligible);
      } else {
        expect(result.rows).toMatchObject([{ hop: "autoplay", module: "react.audio_output", subject: `pt:${input.rows[2]!.participant_id}` }]);
      }
    } finally {
      health.dispose();
    }
  });
});
