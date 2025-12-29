import React from 'react';
import { Toggle, Select } from '../atomic';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface NoiseSuppressionToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  level?: 'low' | 'medium' | 'high';
  onLevelChange?: (level: 'low' | 'medium' | 'high') => void;
  disabled?: boolean;
  className?: string;
}

export const NoiseSuppressionToggle = React.memo(({
  enabled,
  onChange,
  level = 'medium',
  onLevelChange,
  disabled = false,
  className
}: NoiseSuppressionToggleProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const handleLevelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onLevelChange?.(e.target.value as 'low' | 'medium' | 'high');
  };

  return (
    <div className={cn("flex flex-col gap-2 p-3 bg-chalk-bg-subtle rounded-lg border border-chalk-border-subtle", className)}>
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-chalk-text-primary">Noise Suppression</span>
          <span className="text-xs text-chalk-text-muted">Reduce background noise</span>
        </div>
        <Toggle
          checked={enabled}
          onChange={onChange}
          disabled={disabled}
          aria-label="Enable noise suppression"
        />
      </div>

      {enabled && onLevelChange && (
        <div className={cn("mt-1", !prefersReducedMotion && "chalk-animate-fade-in")}>
          <Select
            options={[
              { label: 'Low', value: 'low' },
              { label: 'Medium', value: 'medium' },
              { label: 'High', value: 'high' },
            ]}
            value={level}
            onChange={handleLevelChange}
            size="sm"
            disabled={disabled}
            fullWidth
            aria-label="Noise suppression level"
          />
        </div>
      )}
    </div>
  );
});

NoiseSuppressionToggle.displayName = 'NoiseSuppressionToggle';
