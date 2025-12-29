import React from 'react';
import { cn } from '../../utils/cn';
import { Circle, Radio, Type, AlertCircle } from 'lucide-react';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface StatusBadgeProps {
  status: 'recording' | 'live' | 'transcribing' | 'connecting' | 'reconnecting';
  pulse?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

const config = {
  recording: {
    icon: Circle,
    text: 'REC',
    color: 'var(--chalk-danger)',
    bg: 'rgba(239, 68, 68, 0.1)',
  },
  live: {
    icon: Radio,
    text: 'LIVE',
    color: 'var(--chalk-danger)',
    bg: 'rgba(239, 68, 68, 0.1)',
  },
  transcribing: {
    icon: Type,
    text: 'CC',
    color: 'var(--chalk-accent)',
    bg: 'rgba(59, 130, 246, 0.1)',
  },
  connecting: {
    icon: AlertCircle,
    text: 'CONNECTING...',
    color: 'var(--chalk-warning)',
    bg: 'rgba(234, 179, 8, 0.1)',
  },
  reconnecting: {
    icon: AlertCircle,
    text: 'RECONNECTING...',
    color: 'var(--chalk-warning)',
    bg: 'rgba(234, 179, 8, 0.1)',
  },
};

export const StatusBadge = React.memo(({ status, pulse = false, size = 'md', className }: StatusBadgeProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { icon: Icon, text, color, bg } = config[status];

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--chalk-border-radius-sm)] font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs',
        pulse && !prefersReducedMotion && 'chalk-animate-pulse',
        className
      )}
      style={{
        backgroundColor: bg,
        color: color,
      }}
      role="status"
      aria-label={status}
    >
      <Icon
        size={size === 'sm' ? 10 : 12}
        className={cn(status === 'recording' && 'fill-current')}
      />
      <span>{text}</span>
    </div>
  );
});

StatusBadge.displayName = 'StatusBadge';
