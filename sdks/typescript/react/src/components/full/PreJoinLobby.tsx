"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";

import { Avatar } from "../atomic";
import { CheckmarkCircle02Icon, Microphone01Icon, MicrophoneOff01Icon, Video01Icon, VideoOffIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";

export type PreJoinSettings = {
  readonly displayName: string;
  readonly microphoneEnabled: boolean;
  readonly cameraEnabled: boolean;
};

export interface PreJoinLobbyProps {
  readonly roomName?: string;
  readonly logoUrl?: string;
  readonly defaultDisplayName?: string;
  readonly initialMicrophoneEnabled?: boolean;
  readonly initialCameraEnabled?: boolean;
  readonly isJoining?: boolean;
  readonly error?: string;
  readonly onJoin: (settings: PreJoinSettings) => void | Promise<void>;
  readonly className?: string;
}

export function PreJoinLobby({ roomName = "Chalk room", logoUrl, defaultDisplayName = "", initialMicrophoneEnabled = true, initialCameraEnabled = true, isJoining = false, error, onJoin, className }: PreJoinLobbyProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(initialMicrophoneEnabled);
  const [cameraEnabled, setCameraEnabled] = useState(initialCameraEnabled);
  const [previewError, setPreviewError] = useState("");
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

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
  const hasVideoPreview = cameraEnabled && Boolean(previewStream?.getVideoTracks().length);
  const cameraStatus = !cameraEnabled ? "Camera off" : hasVideoPreview ? "Video looks good" : "Camera on";
  const submit = () => {
    if (!canJoin) return;
    void onJoin({ displayName: displayName.trim(), microphoneEnabled, cameraEnabled });
  };

  return (
    <main data-chalk data-chalk-theme="light" className={cn("chalk-root min-h-screen bg-[#f7f6f2] text-[#0c0e12]", className)}>
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col border-x border-[#deddd7] bg-[#fbfaf7]">
        <header className="flex h-[72px] shrink-0 items-center justify-between gap-5 border-b border-[#deddd7] px-5 sm:px-8 lg:px-10">
          <div className="flex min-w-0 items-center gap-5">
            {logoUrl ? <img src={logoUrl} alt="Chalk" className="h-auto w-32 shrink-0 sm:w-36" draggable={false} /> : <span className="text-2xl font-bold tracking-tight">Chalk</span>}
            <span className="hidden h-7 w-px bg-[#deddd7] sm:block" />
            <span className="hidden max-w-72 truncate text-sm font-medium text-[#555b65] sm:block">{roomName}</span>
          </div>
          <span className="font-mono text-xs text-[#858a92]">Device setup</span>
        </header>

        <section className="grid flex-1 place-items-center px-4 py-10 sm:px-7 lg:px-10 lg:py-14">
          <div className="grid w-full max-w-[1260px] overflow-hidden rounded-[10px] border border-[#c9c8c2] bg-white shadow-[0_2px_4px_rgba(12,14,18,0.04),0_22px_54px_rgba(12,14,18,0.08)] lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="border-b border-[#deddd7] p-4 sm:p-6 lg:border-r lg:border-b-0 lg:p-8">
              <div className="relative aspect-video overflow-hidden rounded-[8px] border border-[#9dcfe1] bg-[linear-gradient(135deg,#eaf7fb_0%,#edf6eb_100%)]">
                <video ref={videoRef} autoPlay playsInline muted className={cn("absolute inset-0 h-full w-full -scale-x-100 object-cover transition-opacity duration-200", hasVideoPreview ? "opacity-100" : "opacity-0")} />
                {!hasVideoPreview && (
                  <div className="absolute inset-0 grid place-items-center">
                    <Avatar name={displayName || "You"} size="2xl" generated={false} className="border border-white/70 shadow-none" />
                  </div>
                )}
                <span className="absolute bottom-3 left-3 rounded-[5px] bg-[#0c0e12]/80 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm">{displayName.trim() || "You"}</span>
              </div>

              <div className="mt-4 grid overflow-hidden rounded-[8px] border border-[#deddd7] sm:grid-cols-2">
                <button
                  type="button"
                  aria-label={microphoneEnabled ? "Mute" : "Unmute"}
                  aria-pressed={microphoneEnabled}
                  onClick={() => setMicrophoneEnabled((value) => !value)}
                  className="flex min-h-16 items-center justify-between gap-4 border-b border-[#deddd7] bg-white px-5 text-left transition hover:bg-[#f7f6f2] sm:border-r sm:border-b-0"
                >
                  <span className="flex items-center gap-3">
                    {microphoneEnabled ? <Microphone01Icon size={20} /> : <MicrophoneOff01Icon size={20} />}
                    <span className="text-sm font-semibold">Microphone</span>
                  </span>
                  <span className={cn("text-xs", microphoneEnabled ? "text-[#4f8c4a]" : "text-[#b94c4c]")}>{microphoneEnabled ? "On" : "Off"}</span>
                </button>
                <button type="button" aria-label={cameraEnabled ? "Stop video" : "Start video"} aria-pressed={cameraEnabled} onClick={() => setCameraEnabled((value) => !value)} className="flex min-h-16 items-center justify-between gap-4 bg-white px-5 text-left transition hover:bg-[#f7f6f2]">
                  <span className="flex items-center gap-3">
                    {cameraEnabled ? <Video01Icon size={20} /> : <VideoOffIcon size={20} />}
                    <span className="text-sm font-semibold">Camera</span>
                  </span>
                  <span className={cn("text-xs", cameraEnabled ? "text-[#4f8c4a]" : "text-[#b94c4c]")}>{cameraEnabled ? "On" : "Off"}</span>
                </button>
              </div>
            </div>

            <aside className="flex flex-col justify-center p-6 sm:p-8 lg:p-10">
              <div>
                <h1 className="text-4xl font-semibold tracking-[-0.04em] lg:text-[42px]">Ready to join?</h1>
                <p className="mt-3 text-sm leading-6 text-[#555b65]">Check your name and devices before entering {roomName}.</p>
              </div>

              <div className="mt-8">
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
                  className="mt-2 h-12 w-full rounded-[7px] border border-[#c9c8c2] bg-white px-4 text-sm outline-none transition placeholder:text-[#858a92] focus-visible:border-[#0c0e12] focus-visible:ring-2 focus-visible:ring-[#b2e0f0] disabled:opacity-50"
                  placeholder="Enter your name"
                />
              </div>

              <dl className="mt-6 divide-y divide-[#deddd7] border-y border-[#deddd7]">
                <div className="flex items-center justify-between gap-4 py-3.5">
                  <dt className="text-sm text-[#555b65]">Microphone</dt>
                  <dd className={cn("flex items-center gap-2 text-xs font-medium", microphoneEnabled ? "text-[#4f8c4a]" : "text-[#b94c4c]")}>
                    {microphoneEnabled && <CheckmarkCircle02Icon size={16} />}
                    {microphoneEnabled ? "Ready" : "Off"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-3.5">
                  <dt className="text-sm text-[#555b65]">Camera</dt>
                  <dd className={cn("flex items-center gap-2 text-xs font-medium", cameraEnabled ? "text-[#4f8c4a]" : "text-[#b94c4c]")}>
                    {cameraEnabled && <CheckmarkCircle02Icon size={16} />}
                    {cameraStatus}
                  </dd>
                </div>
              </dl>

              {(error || previewError) && (
                <p role="alert" className="mt-5 rounded-[7px] border border-[#d67b7b] bg-[#fdf0f0] px-4 py-3 text-sm text-[#9f3f3f]">
                  {error || previewError}
                </p>
              )}

              <button
                type="button"
                onClick={submit}
                disabled={!canJoin}
                className="mt-6 flex h-[52px] w-full items-center justify-center rounded-[7px] bg-[#0c0e12] text-sm font-semibold !text-[#fff] transition hover:bg-[#252830] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0c0e12] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isJoining ? "Joining…" : "Join meeting"}
              </button>
              <p className="mt-4 text-center text-xs leading-5 text-[#858a92]">Camera and microphone controls stay available in the meeting.</p>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}
