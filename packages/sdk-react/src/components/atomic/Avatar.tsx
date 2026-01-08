import React, { useMemo } from 'react';
import { cn } from '../../utils/cn';

export interface AvatarProps {
  name: string;
  src?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  status?: 'online' | 'away' | 'busy' | 'offline';
  className?: string;
}

const sizeMap = {
  xs: { size: 24, fontSize: '0.75rem' },
  sm: { size: 32, fontSize: '0.875rem' },
  md: { size: 48, fontSize: '1rem' },
  lg: { size: 64, fontSize: '1.5rem' },
  xl: { size: 96, fontSize: '2.25rem' },
};

const statusColorMap = {
  online: 'var(--chalk-success)',
  away: 'var(--chalk-warning)',
  busy: 'var(--chalk-danger)',
  offline: 'var(--chalk-text-muted)',
};

export const Avatar = React.memo(({ name, src, size = 'md', status, className }: AvatarProps) => {
  const initials = useMemo(() => {
    if (!name) return '?';
    return name
      .split(' ')
      .slice(0, 2)
      .map((n) => n?.[0] ?? '')
      .join('')
      .toUpperCase() || '?';
  }, [name]);

  const { size: pxSize, fontSize } = sizeMap[size];

  return (
    <div
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: pxSize, height: pxSize }}
      role="img"
      aria-label={`Avatar for ${name}`}
    >
      {src ? (
        <img
          src={src}
          alt={name}
          className="h-full w-full rounded-[var(--chalk-border-radius-full)] object-cover"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center rounded-[var(--chalk-border-radius-full)] bg-[var(--chalk-bg-tertiary)] text-[var(--chalk-text-primary)] font-medium"
          style={{ fontSize }}
        >
          {initials}
        </div>
      )}
      {status && (
        <span
          className="absolute bottom-0 right-0 block rounded-full ring-2 ring-[var(--chalk-bg-primary)]"
          style={{
            width: Math.max(8, pxSize / 4),
            height: Math.max(8, pxSize / 4),
            backgroundColor: statusColorMap[status],
          }}
        />
      )}
    </div>
  );
});

Avatar.displayName = 'Avatar';
