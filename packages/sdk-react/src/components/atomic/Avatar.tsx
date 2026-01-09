import React, { useMemo } from 'react';
import { cn } from '../../utils/cn';

export interface AvatarProps {
  name: string;
  src?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  status?: 'online' | 'away' | 'busy' | 'offline';
  className?: string;
}

const sizeMap = {
  xs: { size: 24, fontSize: '0.75rem' },
  sm: { size: 32, fontSize: '0.875rem' },
  md: { size: 48, fontSize: '1rem' },
  lg: { size: 64, fontSize: '1.5rem' },
  xl: { size: 96, fontSize: '2.25rem' },
  '2xl': { size: 120, fontSize: '2.75rem' },
};

const gradientPairs = [
  ['#667eea', '#764ba2'], // Purple-violet
  ['#f093fb', '#f5576c'], // Pink-rose
  ['#4facfe', '#00f2fe'], // Blue-cyan
  ['#43e97b', '#38f9d7'], // Green-teal
  ['#fa709a', '#fee140'], // Pink-yellow
  ['#a8edea', '#fed6e3'], // Mint-pink
  ['#ff9a9e', '#fecfef'], // Peach-pink
  ['#667eea', '#764ba2'], // Indigo-purple
  ['#ffecd2', '#fcb69f'], // Cream-coral
  ['#a1c4fd', '#c2e9fb'], // Light blue
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function getGradient(name: string): string {
  const hash = hashString(name || 'default');
  const pair = gradientPairs[hash % gradientPairs.length] ?? ['#667eea', '#764ba2'];
  return `linear-gradient(135deg, ${pair[0]} 0%, ${pair[1]} 100%)`;
}

const statusColorMap = {
  online: 'var(--chalk-success)',
  away: 'var(--chalk-warning)',
  busy: 'var(--chalk-danger)',
  offline: 'var(--chalk-text-muted)',
};

export const Avatar = React.memo(({ name, src, size = 'md', status, className }: AvatarProps) => {
  const initials = useMemo(() => {
    if (!name || name.trim() === '') return '?';
    const cleanName = name.trim();
    const parts = cleanName.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    return parts
      .slice(0, 2)
      .map((n) => n[0] || '')
      .join('')
      .toUpperCase() || '?';
  }, [name]);

  const gradient = useMemo(() => getGradient(name || 'unknown'), [name]);
  const { size: pxSize, fontSize } = sizeMap[size];

  return (
    <div
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: pxSize, height: pxSize }}
      role="img"
      aria-label={`Avatar for ${name || 'Unknown'}`}
    >
      {src ? (
        <img
          src={src}
          alt={name}
          className="h-full w-full rounded-[var(--chalk-border-radius-full)] object-cover shadow-lg"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center rounded-[var(--chalk-border-radius-full)] text-white font-medium shadow-lg"
          style={{ fontSize, background: gradient }}
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
