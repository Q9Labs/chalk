"use client";

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Avatar, ControlButton } from "../atomic";
import { Microphone01Icon, MicrophoneOff01Icon, Moon02Icon, Sun02Icon, Video01Icon, VideoOffIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { getParticipantColor, getParticipantGradient } from "../../utils/colorGenerator";

export type PreJoinSettings = {
  readonly displayName: string;
  readonly microphoneEnabled: boolean;
  readonly cameraEnabled: boolean;
};

export interface PreJoinLobbyProps {
  readonly roomName?: string;
  readonly defaultDisplayName?: string;
  readonly initialMicrophoneEnabled?: boolean;
  readonly initialCameraEnabled?: boolean;
  readonly isJoining?: boolean;
  readonly error?: string;
  readonly onJoin: (settings: PreJoinSettings) => void | Promise<void>;
  readonly className?: string;
}

export function PreJoinLobby({ roomName = "Chalk room", defaultDisplayName = "", initialMicrophoneEnabled = true, initialCameraEnabled = true, isJoining = false, error, onJoin, className }: PreJoinLobbyProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(initialMicrophoneEnabled);
  const [cameraEnabled, setCameraEnabled] = useState(initialCameraEnabled);
  const [isDark, setDark] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const gradient = useMemo(() => getParticipantGradient(displayName), [displayName]);
  const participantColor = useMemo(() => getParticipantColor(displayName).primary, [displayName]);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia || (!microphoneEnabled && !cameraEnabled)) {
      setPreviewStream((current) => {
        current?.getTracks().forEach((track) => track.stop());
        return null;
      });
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    void navigator.mediaDevices
      .getUserMedia({ audio: microphoneEnabled, video: cameraEnabled })
      .then((nextStream) => {
        stream = nextStream;
        if (cancelled) {
          nextStream.getTracks().forEach((track) => track.stop());
          return;
        }
        setPreviewError("");
        setPreviewStream((current) => {
          current?.getTracks().forEach((track) => track.stop());
          return nextStream;
        });
      })
      .catch(() => {
        if (!cancelled) setPreviewError("Camera or microphone preview is unavailable. You can still join with them turned off.");
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraEnabled, microphoneEnabled]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = previewStream;
    return () => {
      if (videoRef.current?.srcObject === previewStream) videoRef.current.srcObject = null;
    };
  }, [previewStream]);

  useEffect(
    () => () => {
      previewStream?.getTracks().forEach((track) => track.stop());
    },
    [previewStream],
  );

  const canJoin = displayName.trim().length > 0 && !isJoining;
  const submit = () => {
    if (!canJoin) return;
    void onJoin({ displayName: displayName.trim(), microphoneEnabled, cameraEnabled });
  };

  return (
    <main data-chalk data-chalk-theme={isDark ? "dark" : "light"} className={cn("chalk-root min-h-screen overflow-hidden bg-background text-foreground", isDark && "dark", className)} style={{ "--primary": participantColor } as React.CSSProperties}>
      <div className="pointer-events-none absolute inset-0 opacity-60" style={{ background: "var(--chalk-lobby-gradient)" }} />
      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 sm:px-7 lg:px-8">
        <header className="flex items-center justify-between gap-4 py-6">
          <div className="flex min-w-0 items-center gap-4">
            <img src="/brand/chalk/chalk-logo.svg" alt="Chalk" className={cn("h-auto w-36 shrink-0 sm:w-44", isDark && "invert")} draggable={false} />
            <span className="hidden h-6 w-px bg-border/70 sm:block" />
            <span className="hidden max-w-64 truncate text-sm font-semibold text-muted-foreground sm:block">{roomName}</span>
          </div>
          <button type="button" onClick={() => setDark((value) => !value)} className="grid h-11 w-11 place-items-center rounded-full text-foreground shadow-sm transition hover:bg-muted hover:shadow-md" aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}>
            {isDark ? <Sun02Icon size={21} /> : <Moon02Icon size={21} />}
          </button>
        </header>

        <section className="grid flex-1 items-center gap-10 pb-14 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-16">
          <div className="group relative w-full">
            <div className="absolute -inset-3 rounded-[2rem] opacity-35 blur-2xl" style={{ background: gradient }} />
            <div className="relative aspect-video w-full overflow-hidden rounded-3xl bg-[var(--chalk-bg-tile)] shadow-[var(--chalk-shadow-xl)]" style={{ backgroundImage: gradient }}>
              <video ref={videoRef} autoPlay playsInline muted className={cn("absolute inset-0 h-full w-full -scale-x-100 object-cover transition-opacity duration-300", cameraEnabled && previewStream?.getVideoTracks().length ? "opacity-100" : "opacity-0")} />
              {(!cameraEnabled || !previewStream?.getVideoTracks().length) && (
                <div className="absolute inset-0 grid place-items-center">
                  <Avatar name={displayName || "You"} size="2xl" className="scale-125 shadow-2xl" />
                </div>
              )}
              <div className="absolute left-5 top-5 flex items-center gap-3 rounded-full border border-[var(--chalk-lobby-glass-border)] bg-[var(--chalk-lobby-glass-bg)] px-4 py-2.5 shadow-lg backdrop-blur-xl">
                <span className={cn("h-2.5 w-2.5 rounded-full", microphoneEnabled ? "bg-primary shadow-[0_0_10px_var(--primary)]" : "bg-muted-foreground/40")} />
                <span className="text-sm font-semibold">{displayName.trim() || "You"}</span>
              </div>
              <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--chalk-lobby-glass-border)] bg-[var(--chalk-lobby-glass-bg)] p-2 shadow-2xl backdrop-blur-xl">
                <ControlButton icon={microphoneEnabled ? <Microphone01Icon /> : <MicrophoneOff01Icon />} label={microphoneEnabled ? "Mute" : "Unmute"} active={microphoneEnabled} danger={!microphoneEnabled} onClick={() => setMicrophoneEnabled((value) => !value)} hideTooltip />
                <ControlButton icon={cameraEnabled ? <Video01Icon /> : <VideoOffIcon />} label={cameraEnabled ? "Stop video" : "Start video"} active={cameraEnabled} danger={!cameraEnabled} onClick={() => setCameraEnabled((value) => !value)} hideTooltip />
              </div>
            </div>
          </div>

          <div className="w-full max-w-sm space-y-8 lg:justify-self-end">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Everything looks good</p>
              <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">Ready to join?</h1>
              <p className="text-base leading-relaxed text-muted-foreground">Choose how you’ll enter, then step into the room.</p>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="display-name" className="block text-sm font-medium">
                  Your name
                </label>
                <input
                  id="display-name"
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submit();
                  }}
                  disabled={isJoining}
                  className="h-14 w-full rounded-2xl border-2 border-border bg-card px-5 text-base outline-none transition placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20 disabled:opacity-50"
                  placeholder="Enter your name"
                />
              </div>
              {(error || previewError) && (
                <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error || previewError}
                </p>
              )}
              <button
                type="button"
                onClick={submit}
                disabled={!canJoin}
                className="relative flex h-14 w-full items-center justify-center overflow-hidden rounded-full bg-primary text-base font-semibold text-primary-foreground shadow-lg transition hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isJoining ? "Joining…" : "Join meeting"}
              </button>
              <p className="text-center text-xs text-muted-foreground">Camera and microphone controls remain available in the meeting.</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
