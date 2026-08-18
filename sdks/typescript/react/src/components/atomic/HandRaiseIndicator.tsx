import React from "react";
import { HandIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkBadge } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicHandRaiseIndicator } from "./ClassicHandRaiseIndicator";

interface HandRaiseIndicatorProps {
  raised: boolean;
  animated?: boolean;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const positionMap = {
  "top-left": "top-2 left-2",
  "top-right": "top-2 right-2",
  "bottom-left": "bottom-2 left-2",
  "bottom-right": "bottom-2 right-2",
};

const sizeMap = {
  sm: 10,
  md: 18,
  lg: 24,
};

const wrapperSizeMap = {
  sm: "p-0.5 ring-1",
  md: "p-1 ring-2",
  lg: "p-1.5 ring-2",
};

export const HandRaiseIndicator = React.memo((props: HandRaiseIndicatorProps) => {
  const skin = useSkin();

  return skin === "classic" ? <ClassicHandRaiseIndicator {...props} /> : <ChalkHandRaiseIndicator {...props} />;
});

function ChalkHandRaiseIndicator({ raised, animated = true, position = "top-right", size = "md", className }: HandRaiseIndicatorProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

  if (!raised) return null;

  return (
    <ChalkBadge
      tone="accent"
      className={cn(
        "absolute z-10 flex items-center justify-center min-h-0 min-w-0 rounded-full text-[var(--chalk-accent-text)] shadow-sm ring-[var(--chalk-surface)]",
        wrapperSizeMap[size],
        positionMap[position],
        !prefersReducedMotion && "chalk-animate-scale-in",
        animated && !prefersReducedMotion && "chalk-animate-hand-bounce",
        className,
      )}
      role="status"
      aria-label="Hand raised"
    >
      <HandIcon size={sizeMap[size]} fill="currentColor" />
    </ChalkBadge>
  );
}

HandRaiseIndicator.displayName = "HandRaiseIndicator";
