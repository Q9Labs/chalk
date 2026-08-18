import React from "react";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkPanel, ChalkSelect, ChalkToggle } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicNoiseSuppressionToggle } from "./ClassicNoiseSuppressionToggle";

export interface NoiseSuppressionToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  level?: "low" | "medium" | "high";
  onLevelChange?: (level: "low" | "medium" | "high") => void;
  disabled?: boolean;
  className?: string;
}

const ChalkNoiseSuppressionToggle = React.memo(({ enabled, onChange, level = "medium", onLevelChange, disabled = false, className }: NoiseSuppressionToggleProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const handleLevelChange = (e: { target: { value: string } }) => {
    onLevelChange?.(e.target.value as "low" | "medium" | "high");
  };

  return (
    <ChalkPanel className={cn("flex flex-col gap-2 !rounded-lg !p-3 bg-[var(--chalk-stage)]", className)}>
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-[var(--chalk-accent)]">Noise Suppression</span>
          <span className="text-xs text-[var(--chalk-muted-text)]">Reduce background noise</span>
        </div>
        <ChalkToggle pressed={enabled} onPressedChange={onChange} disabled={disabled} aria-label="Enable noise suppression" />
      </div>

      {enabled && onLevelChange && (
        <div className={cn("mt-1", !prefersReducedMotion && "chalk-animate-fade-in")}>
          <ChalkSelect value={level} onChange={handleLevelChange} disabled={disabled} aria-label="Noise suppression level">
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </ChalkSelect>
        </div>
      )}
    </ChalkPanel>
  );
});

ChalkNoiseSuppressionToggle.displayName = "ChalkNoiseSuppressionToggle";

export const NoiseSuppressionToggle = React.memo((props: NoiseSuppressionToggleProps): React.JSX.Element => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicNoiseSuppressionToggle {...props} /> : <ChalkNoiseSuppressionToggle {...props} />;
});

NoiseSuppressionToggle.displayName = "NoiseSuppressionToggle";
