import React, { useEffect } from 'react';
import { Info, CheckCircle, AlertTriangle, XCircle, X } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface ToastProps {
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
  onDismiss?: () => void;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export const Toast = React.memo<ToastProps>(({
  message,
  type = 'info',
  duration = 0,
  onDismiss,
  action,
  className,
}) => {
  useEffect(() => {
    if (duration > 0 && onDismiss) {
      const timer = setTimeout(onDismiss, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onDismiss]);

  const icons = {
    info: <Info size={20} className="text-[var(--chalk-accent)]" />,
    success: <CheckCircle size={20} className="text-[var(--chalk-success)]" />,
    warning: <AlertTriangle size={20} className="text-[var(--chalk-warning)]" />,
    error: <XCircle size={20} className="text-[var(--chalk-danger)]" />,
  };

  const bgColors = {
    info: 'bg-[var(--chalk-bg-secondary)] border-l-4 border-l-[var(--chalk-accent)]',
    success: 'bg-[var(--chalk-bg-secondary)] border-l-4 border-l-[var(--chalk-success)]',
    warning: 'bg-[var(--chalk-bg-secondary)] border-l-4 border-l-[var(--chalk-warning)]',
    error: 'bg-[var(--chalk-bg-secondary)] border-l-4 border-l-[var(--chalk-danger)]',
  };

  return (
    <div
      className={cn(
        'flex items-start gap-3 p-4 rounded-[var(--chalk-border-radius-md)] shadow-[var(--chalk-shadow-lg)] min-w-[300px] max-w-md chalk-animate-toast-in border border-[var(--chalk-border-color)]',
        bgColors[type],
        className
      )}
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
    >
      <div className="flex-shrink-0 mt-0.5">{icons[type]}</div>
      <div className="flex-1">
        <p className="text-sm font-medium text-[var(--chalk-text-primary)]">{message}</p>
        {action && (
          <button
            onClick={action.onClick}
            className="mt-2 text-sm font-semibold text-[var(--chalk-text-primary)] hover:underline focus:outline-none"
          >
            {action.label}
          </button>
        )}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="flex-shrink-0 text-[var(--chalk-text-muted)] hover:text-[var(--chalk-text-primary)] transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
});

Toast.displayName = 'Toast';
