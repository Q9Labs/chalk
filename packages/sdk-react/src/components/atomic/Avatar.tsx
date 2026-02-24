import React, { useMemo } from 'react';
import { cn } from '../../utils/cn';

export interface AvatarProps {
  name: string;
  src?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  status?: 'online' | 'away' | 'busy' | 'offline';
  className?: string;
  style?: React.CSSProperties;
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
  ['#1bb6a6', '#0d9488'], // Brand teal
  ['#0d9488', '#115e59'], // Teal deep
  ['#06b6d4', '#0891b2'], // Cyan
  ['#10b981', '#059669'], // Emerald
  ['#2dd4bf', '#14b8a6'], // Teal light
  ['#0ea5e9', '#0284c7'], // Sky
  ['#3b82f6', '#2563eb'], // Blue
  ['#6366f1', '#4f46e5'], // Indigo
  ['#22c55e', '#16a34a'], // Green
  ['#8b5cf6', '#7c3aed'], // Violet
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
  online: 'var(--success)',
  away: 'var(--warning)',
  busy: 'var(--destructive)',
  offline: 'var(--muted-foreground)',
};

export const Avatar = React.memo(({ name, src, size = 'md', status, className, style }: AvatarProps) => {
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
      style={{ width: pxSize, height: pxSize, ...style }}
      role="img"
      aria-label={`Avatar for ${name || 'Unknown'}`}
    >
      {src ? (
        <img
          src={src}
          alt={name}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center rounded-full text-primary-foreground font-medium"
          style={{ fontSize, background: gradient }}
        >
          {initials}
        </div>
      )}
      {status && (
        <span
          className="absolute bottom-0 right-0 block rounded-full ring-2 ring-background"
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
