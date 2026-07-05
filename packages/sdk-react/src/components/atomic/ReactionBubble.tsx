import React, { useEffect, useState, useMemo } from "react";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import { getParticipantColor } from "../../utils/colorGenerator";
import { CELEBRATION_EMOJIS } from "@q9labs/chalk-ui/reactions";

interface ReactionBubbleProps {
  emoji: string;
  participantName?: string;
  onComplete?: () => void;
  duration?: number;
  className?: string;
}

const BASE_PARTICLE_COLORS = ["#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#22c55e"];

// Generate random animation properties for natural movement
const generateAnimationProps = () => ({
  offsetX: Math.random() * 120 - 60,
  travelY: 80 + Math.random() * 70,
  rotation: Math.random() * 40 - 20,
  scale: 1 + Math.random() * 0.3,
  duration: 2500 + Math.random() * 1000,
  delay: Math.random() * 100,
});

// Generate particle data once
const generateParticles = (primaryColor: string) => {
  const particleColors = [...BASE_PARTICLE_COLORS, primaryColor, primaryColor]; // Weight primary color more
  return Array.from({ length: 16 }, (_, i) => {
    const angle = (360 / 16) * i + (Math.random() * 20 - 10);
    const radians = (angle * Math.PI) / 180;
    const distance = 35 + Math.random() * 25;
    return {
      id: i,
      x: Math.cos(radians) * distance,
      y: Math.sin(radians) * distance,
      size: 4 + Math.random() * 5,
      color: particleColors[Math.floor(Math.random() * particleColors.length)],
      delay: Math.random() * 150,
      duration: 600 + Math.random() * 300,
    };
  });
};

export const ReactionBubble = React.memo(({ emoji, participantName, onComplete, duration: baseDuration = 3000, className }: ReactionBubbleProps) => {
  const [isVisible, setIsVisible] = useState(true);
  const prefersReducedMotion = usePrefersReducedMotion();

  const participantColors = useMemo(() => getParticipantColor(participantName || "unknown"), [participantName]);
  const isCelebration = CELEBRATION_EMOJIS.includes(emoji);
  const animProps = useMemo(() => generateAnimationProps(), []);
  const particles = useMemo(() => (isCelebration ? generateParticles(participantColors.primary) : []), [isCelebration, participantColors.primary]);
  const timeoutMs = baseDuration;
  const floatDurationMs = prefersReducedMotion ? baseDuration : animProps.duration;

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      onComplete?.();
    }, timeoutMs);

    return () => clearTimeout(timer);
  }, [timeoutMs, onComplete]);

  if (!isVisible) return null;

  const animationStyle = prefersReducedMotion
    ? ({ "--primary": participantColors.primary } as React.CSSProperties)
    : ({
        "--primary": participantColors.primary,
        "--float-offset-x": `${animProps.offsetX}px`,
        "--float-travel-y": `${animProps.travelY}px`,
        "--float-rotation": `${animProps.rotation}deg`,
        "--float-scale": animProps.scale,
        "--float-duration": `${floatDurationMs}ms`,
        animationDelay: `${animProps.delay}ms`,
      } as React.CSSProperties);

  return (
    <div className={cn("pointer-events-none relative w-16 h-16 flex items-center justify-center", !prefersReducedMotion && "chalk-animate-reaction-float", className)} style={animationStyle} role="presentation" aria-hidden="true">
      {/* Particle effects for celebration */}
      {isCelebration &&
        !prefersReducedMotion &&
        particles.map((particle) => (
          <div
            key={particle.id}
            className="absolute rounded-full"
            style={
              {
                width: particle.size,
                height: particle.size,
                backgroundColor: particle.color,
                left: "50%",
                top: "50%",
                marginLeft: -particle.size / 2,
                marginTop: -particle.size / 2,
                animation: `chalk-particle-explode ${particle.duration}ms ease-out ${particle.delay}ms forwards`,
                "--particle-x": `${particle.x}px`,
                "--particle-y": `${particle.y}px`,
              } as React.CSSProperties
            }
          />
        ))}

      {/* Main emoji */}
      <div className={cn("relative z-10 text-5xl", !prefersReducedMotion && "chalk-animate-reaction-bounce-in", !prefersReducedMotion && "chalk-animate-reaction-wiggle")}>{emoji}</div>

      {/* Participant name badge */}
      {participantName && participantName.toLowerCase() !== "unknown" && (
        <div className={cn("absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium text-white border border-white/5 shadow-sm", !prefersReducedMotion && "animate-in fade-in duration-300")} style={{ backgroundColor: participantColors.primary }}>
          {participantName}
        </div>
      )}
    </div>
  );
});

ReactionBubble.displayName = "ReactionBubble";
