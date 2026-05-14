import { useEffect, useRef, useState } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Loader2, AlertCircle } from "lucide-react";
import { cn } from "../lib/utils";

interface VideoPlayerProps {
  url: string;
  className?: string;
  autoPlay?: boolean;
}

export function formatTime(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VideoPlayer({ url, className, autoPlay = false }: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [isBuffering, setIsBuffering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);

  const controlsTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (autoPlay && videoRef.current) {
      videoRef.current.play().catch((e) => {
        console.error("Auto-play failed:", e);
        setIsPlaying(false);
      });
    }
  }, [autoPlay, url]);

  // Controls visibility timeout
  const resetControlsTimeout = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    if (isPlaying) {
      controlsTimeoutRef.current = window.setTimeout(() => {
        setShowControls(false);
      }, 2500);
    }
  };

  useEffect(() => {
    resetControlsTimeout();
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [isPlaying]);

  // Handle Fullscreen events
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const current = videoRef.current.currentTime;
    setCurrentTime(current);
    const progressPercent = (current / videoRef.current.duration) * 100;
    setProgress(isNaN(progressPercent) ? 0 : progressPercent);
  };

  const handleLoadedData = () => {
    if (!videoRef.current) return;
    setDuration(videoRef.current.duration);
    setIsBuffering(false);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current || !duration) return;
    const bar = e.currentTarget;
    const clickPosition = (e.clientX - bar.getBoundingClientRect().left) / bar.offsetWidth;
    const newTime = clickPosition * duration;
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;
    const val = parseFloat(e.target.value);
    videoRef.current.volume = val;
    setVolume(val);
    if (val === 0) {
      videoRef.current.muted = true;
      setIsMuted(true);
    } else if (isMuted) {
      videoRef.current.muted = false;
      setIsMuted(false);
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen();
    }
  };

  return (
    <div ref={containerRef} className={cn("relative group overflow-hidden bg-black/95 border border-border/50 rounded-xl", className)} onMouseMove={resetControlsTimeout} onMouseLeave={() => isPlaying && setShowControls(false)} onDoubleClick={toggleFullscreen}>
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-20 text-destructive gap-3 text-center p-6">
          <AlertCircle size={32} />
          <div>
            <p className="font-bold">Playback Error</p>
            <p className="text-sm opacity-80">{error}</p>
          </div>
        </div>
      )}

      {isBuffering && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10 pointer-events-none">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
        </div>
      )}

      {/* Video Element */}
      <video
        ref={videoRef}
        src={url}
        className="w-full h-full object-contain cursor-pointer"
        onClick={togglePlay}
        onTimeUpdate={handleTimeUpdate}
        onLoadedData={handleLoadedData}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
        onError={() => setError("Error loading video playback.")}
        crossOrigin="anonymous"
      />

      {/* Custom Controls UI */}
      <div className={cn("absolute inset-0 pointer-events-none transition-opacity duration-300", showControls || !isPlaying ? "opacity-100" : "opacity-0")}>
        {/* Playback overlay layer */}
        <div className="absolute inset-0 flex items-center justify-center">
          {!isPlaying && !isBuffering && !error && (
            <button
              onClick={togglePlay}
              className="w-16 h-16 rounded-full bg-primary/90 text-primary-foreground flex items-center justify-center pointer-events-auto shadow-lg hover:scale-110 active:scale-95 transition-all outline-none focus-visible:ring-4 focus-visible:ring-primary/40 backdrop-blur-md"
              aria-label="Play video"
            >
              <Play className="w-8 h-8 ml-1" />
            </button>
          )}
        </div>

        {/* Bottom controls bar */}
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-auto">
          {/* Progress bar */}
          <div className="w-full h-1.5 bg-white/20 rounded-full mb-4 cursor-pointer relative group/progress" onClick={handleSeek}>
            {/* Hover preview line */}
            <div className="absolute inset-y-0 left-0 bg-white/30 w-full scale-y-100 group-hover/progress:scale-y-[2] opacity-0 group-hover/progress:opacity-100 transition-all rounded-full" />

            {/* Current progress */}
            <div className="absolute inset-y-0 left-0 bg-primary rounded-full group-hover/progress:scale-y-[2] transition-transform origin-left" style={{ width: `${progress}%` }}>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md opacity-0 group-hover/progress:opacity-100 transition-opacity translate-x-1/2" />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <button onClick={togglePlay} className="text-white hover:text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary rounded" aria-label={isPlaying ? "Pause" : "Play"}>
                {isPlaying ? <Pause size={20} /> : <Play size={20} />}
              </button>

              <div className="flex items-center gap-2 group/volume">
                <button onClick={toggleMute} className="text-white hover:text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary rounded" aria-label={isMuted ? "Unmute" : "Mute"}>
                  {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
                <div className="w-0 overflow-hidden group-hover/volume:w-20 transition-all duration-200 ease-out flex items-center">
                  <input type="range" min="0" max="1" step="0.05" value={isMuted ? 0 : volume} onChange={handleVolumeChange} className="w-20 h-1 appearance-none cursor-pointer rounded-full bg-white/20 accent-primary" aria-label="Volume" />
                </div>
              </div>

              <div className="text-xs font-semibold tabular-nums text-white/90">
                {formatTime(currentTime)} / {formatTime(duration)}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button onClick={toggleFullscreen} className="text-white hover:text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary rounded p-1" aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
                {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
