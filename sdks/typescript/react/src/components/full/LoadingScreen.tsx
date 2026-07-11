import React, { memo, useEffect, useMemo, useState } from "react";
import { cn } from "../../utils/cn";
import { getParticipantColor, type ParticipantGradientPreference } from "../../utils/colorGenerator";

export interface LoadingScreenProps {
  message?: string;
  className?: string;
  /** Display name or participant ID used to generate dynamic colors */
  displayName?: string;
  supportingMessages?: readonly string[];
  gradientPreference?: ParticipantGradientPreference;
}

const EMPTY_SUPPORTING_MESSAGES: readonly string[] = [];

function LoadingScreenBase({ message = "Loading...", className, displayName = "Chalk User", supportingMessages = EMPTY_SUPPORTING_MESSAGES, gradientPreference }: LoadingScreenProps): React.JSX.Element {
  const [headlineMessageIndex, setHeadlineMessageIndex] = useState(0);

  // Tie colors directly to the user's generated gradient palette
  const colors = useMemo(() => getParticipantColor(displayName, gradientPreference), [displayName, gradientPreference]);
  const primaryColor = colors.primary;
  const headlineMessages = useMemo(() => [message, ...supportingMessages], [message, supportingMessages]);
  const activeHeadlineMessage = headlineMessages[headlineMessageIndex] ?? message;

  useEffect(() => {
    setHeadlineMessageIndex(0);
  }, [headlineMessages]);

  useEffect(() => {
    if (headlineMessages.length <= 1) return;

    const intervalId = window.setInterval(() => {
      setHeadlineMessageIndex((currentIndex) => (currentIndex + 1) % headlineMessages.length);
    }, 1800);

    return () => window.clearInterval(intervalId);
  }, [headlineMessages]);

  return (
    <div data-chalk className={cn("relative flex flex-col items-center justify-center min-h-screen bg-background text-foreground overflow-hidden transition-colors duration-1000 font-sans", className)}>
      {/* Full Screen Background Renderer - Massive Ambient Aura */}
      <div className="absolute inset-0 z-0 pointer-events-none w-full h-full flex items-center justify-center opacity-30 dark:opacity-40 animate-in fade-in duration-1000">
        <div className="w-[120vw] h-[120vw] md:w-[80vw] md:h-[80vw] rounded-full blur-[100px] md:blur-[150px] animate-pulse [animation-duration:8s] motion-reduce:animate-none" style={{ backgroundColor: primaryColor }} />
      </div>

      {/* Ambient background glow derived from user's color (Subtle base layer) */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.08] transition-all duration-1000"
        style={{
          background: `radial-gradient(circle at center, ${primaryColor} 0%, transparent 70%)`,
        }}
      />

      {/* Foreground Typography / Branding */}
      <div className="relative z-10 flex flex-col items-center gap-8 px-6 text-center animate-in fade-in zoom-in-95 duration-1000">
        <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
          <p className="text-3xl md:text-4xl font-bold tracking-tight text-foreground drop-shadow-2xl">{activeHeadlineMessage}</p>

          {/* Professional Progress Indicator */}
          <div className="flex gap-2.5 mt-2" aria-hidden="true">
            <div className="w-2 h-2 rounded-full bg-foreground/40 animate-bounce [animation-delay:-0.3s] motion-reduce:animate-none" />
            <div className="w-2 h-2 rounded-full bg-foreground/40 animate-bounce [animation-delay:-0.15s] motion-reduce:animate-none" />
            <div className="w-2 h-2 rounded-full bg-foreground/40 animate-bounce motion-reduce:animate-none" />
          </div>
        </div>
      </div>
    </div>
  );
}

export const LoadingScreen = memo(LoadingScreenBase);
LoadingScreen.displayName = "LoadingScreen";
