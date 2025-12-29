import { cn } from '../../utils/cn';

export interface ConnectionQualityProps {
  quality: 1 | 2 | 3 | 4;
  showLabel?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

const labels = {
  1: 'Poor',
  2: 'Fair',
  3: 'Good',
  4: 'Excellent',
};

const colors = {
  1: 'var(--chalk-danger)',
  2: 'var(--chalk-warning)',
  3: 'var(--chalk-success)',
  4: 'var(--chalk-success)',
};

export const ConnectionQuality = ({ quality, showLabel = false, size = 'md', className }: ConnectionQualityProps) => {
  const barHeight = size === 'sm' ? 10 : 14;
  const barWidth = size === 'sm' ? 3 : 4;

  const clampedQuality = Math.max(1, Math.min(4, quality)) as 1 | 2 | 3 | 4;
  const color = colors[clampedQuality];

  return (
    <div
      className={cn('inline-flex items-end gap-0.5', className)}
      title={`Connection Quality: ${labels[clampedQuality]}`}
      role="status"
      aria-label={`Connection quality: ${labels[clampedQuality]}`}
    >
      {[1, 2, 3, 4].map((level) => (
        <div
          key={level}
          style={{
            width: barWidth,
            height: (barHeight / 4) * level,
            backgroundColor: level <= clampedQuality ? color : 'var(--chalk-bg-tertiary)',
            borderRadius: '1px',
          }}
        />
      ))}
      {showLabel && (
        <span className="ml-1 text-xs text-[var(--chalk-text-secondary)]">
          {labels[clampedQuality]}
        </span>
      )}
    </div>
  );
};
