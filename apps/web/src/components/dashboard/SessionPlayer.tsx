import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import type { RecordingDTO } from "../../lib/dashboard/contracts";
import { act } from "../../lib/dashboard/client";
import { playbackTime } from "../../lib/dashboard/format";
import { Icon } from "../site/Icon";
import type { Ids } from "./session-reads";

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

/** The signed address of a recording, or that it couldn't be read. */
function useRecordingSource(ids: Ids, recordingId: string, onMint: (expiresAt: string) => void) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    act("past-session", { action: "recording-url", ...ids, recordingId, download: false }).then(
      (result) => {
        if (!current) return;
        setSource(result.url);
        onMint(result.expiresAt);
      },
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [ids, recordingId, onMint]);
  return { source, failed };
}

function Scrubber({ time, length, onSeek }: { readonly time: number; readonly length: number; readonly onSeek: (seconds: number) => void }) {
  const percent = length ? (time / length) * 100 : 0;
  function scrub(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    onSeek(((event.clientX - rect.left) / rect.width) * length);
  }
  function scrubKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    onSeek(time + (event.key === "ArrowRight" ? 5 : -5));
  }
  return (
    <div className="pscrub" role="slider" tabIndex={0} aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(length)} aria-valuenow={Math.round(time)} aria-valuetext={`${playbackTime(time)} of ${playbackTime(length)}`} onPointerDown={scrub} onKeyDown={scrubKeys}>
      <span>
        <i style={{ width: `${percent}%` }} />
        <b style={{ left: `${percent}%` }} />
      </span>
    </div>
  );
}

function SpeedButton({ video }: { readonly video: RefObject<HTMLVideoElement | null> }) {
  const [speed, setSpeed] = useState(1);
  return (
    <button
      type="button"
      className="pb sp hide-ph"
      aria-label={`Playback speed ${speed} times`}
      onClick={() => {
        const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
        setSpeed(next);
        if (video.current) video.current.playbackRate = next;
      }}
    >
      {speed}×
    </button>
  );
}

export function Player({ ids, recording, onTime, seekRef }: { readonly ids: Ids; readonly recording: RecordingDTO; readonly onTime: (seconds: number) => void; readonly seekRef: RefObject<(seconds: number) => void> }) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const playerId = useRef(crypto.randomUUID()).current;
  const mintedAt = useRef(0);
  const expiresAt = useRef(0);
  const mints = useRef(0);
  const progressed = useRef(false);
  const onMint = (expires: string) => {
    mintedAt.current = Date.now();
    expiresAt.current = Date.parse(expires);
    mints.current += 1;
  };
  const { source, failed } = useRecordingSource(ids, recording.id, onMint);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);

  const playbackEvent = (name: "playback.media_error" | "playback.progressed" | "playback.player_error_note", extra?: Record<string, unknown>) =>
    void act("past-session", { action: "playback-event", ...ids, recordingId: recording.id, name, playerId, ...extra }).catch(() => {});

  useEffect(() => {
    if (failed) playbackEvent("playback.player_error_note", { surfaceState: "shown" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed]);

  const jump = (seconds: number) => {
    const element = video.current;
    if (!element) return;
    element.currentTime = Math.max(0, Math.min(length || element.duration || 0, seconds));
  };
  seekRef.current = jump;

  if (failed)
    return (
      <div className="pnote" role="alert">
        <div>
          <Icon name="alert" />
          <b>The recording didn’t load</b>
          <p>Reload the page to try again.</p>
        </div>
      </div>
    );

  return (
    <div className="player" role="region" aria-label="Recording" ref={box}>
      <video
        ref={video}
        src={source ?? undefined}
        playsInline
        preload="metadata"
        muted={muted}
        onClick={() => (playing ? video.current?.pause() : void video.current?.play())}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(event) => setLength(event.currentTarget.duration)}
        onError={() =>
          playbackEvent("playback.media_error", {
            mediaErrorCode: video.current?.error?.code ?? 0,
            urlAgeMs: mintedAt.current ? Date.now() - mintedAt.current : 0,
            urlLifetimeMs: expiresAt.current && mintedAt.current ? expiresAt.current - mintedAt.current : 0,
            mintCount: mints.current,
            canPlayMp4: typeof document !== "undefined" ? document.createElement("video").canPlayType("video/mp4") : "probably",
          })
        }
        onTimeUpdate={(event) => {
          setTime(event.currentTarget.currentTime);
          onTime(event.currentTarget.currentTime);
          if (!progressed.current && event.currentTarget.currentTime >= 2 && !event.currentTarget.paused) {
            progressed.current = true;
            playbackEvent("playback.progressed");
          }
        }}
      />
      <div className="pctl">
        <button type="button" className="pb" aria-label={playing ? "Pause" : "Play"} onClick={() => (playing ? video.current?.pause() : void video.current?.play())}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <span className="ptime num">
          {playbackTime(time)} / {playbackTime(length)}
        </span>
        <Scrubber time={time} length={length} onSeek={jump} />
        <SpeedButton video={video} />
        <button type="button" className="pb hide-ph" aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={() => setMuted((value) => !value)}>
          <Icon name="vol" />
        </button>
        <button type="button" className="pb" aria-label="Full screen" onClick={() => void box.current?.requestFullscreen?.()}>
          <Icon name="max" />
        </button>
      </div>
    </div>
  );
}
