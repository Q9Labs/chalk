import React, { useEffect, useMemo, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { cn } from '../../utils/cn';
import { InformationCircleIcon, CheckmarkCircle02Icon, Alert02Icon, CancelCircleIcon } from '../../utils/icons';
import { getParticipantThemeVariables } from '../../utils/colorGenerator';

export interface Notification {
  id: string;
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface NotificationStackProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  maxVisible?: number;
  participantColorSeed?: string;
  className?: string;
}

const positionMap = {
  'top-right': 'top-right' as const,
  'top-left': 'top-left' as const,
  'bottom-right': 'bottom-right' as const,
  'bottom-left': 'bottom-left' as const,
};

export const NotificationStack = React.memo<NotificationStackProps>(({
  notifications,
  onDismiss,
  position = 'top-right',
  maxVisible = 5,
  participantColorSeed,
  className,
}) => {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    }
    return 'light';
  });
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed), [participantColorSeed]);

  useEffect(() => {
    const handleThemeChange = () => {
      setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    };

    handleThemeChange();

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          handleThemeChange();
        }
      });
    });

    observer.observe(document.documentElement, { attributes: true });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const activeIds = new Set<string>();

    notifications.slice(0, maxVisible).forEach((notification) => {
      if (activeIds.has(notification.id)) return;
      activeIds.add(notification.id);

      const toastOptions = {
        id: notification.id,
        duration: notification.duration ?? 5000,
        onDismiss: () => onDismiss(notification.id),
        action: notification.action ? {
          label: notification.action.label,
          onClick: notification.action.onClick,
        } : undefined,
      };

      switch (notification.type) {
        case 'success':
          toast.success(notification.message, toastOptions);
          break;
        case 'error':
          toast.error(notification.message, toastOptions);
          break;
        case 'warning':
          toast.warning(notification.message, toastOptions);
          break;
        default:
          toast.info(notification.message, toastOptions);
      }
    });
  }, [notifications, maxVisible, onDismiss]);

  return (
    <Toaster
      theme={theme}
      position={positionMap[position]}
      visibleToasts={maxVisible}
      closeButton
      icons={{
        info: <InformationCircleIcon size={20} className="text-primary" />,
        success: <CheckmarkCircle02Icon size={20} className="text-success" />,
        warning: <Alert02Icon size={20} className="text-warning" />,
        error: <CancelCircleIcon size={20} className="text-destructive" />,
      }}
      toastOptions={{
        classNames: {
          toast: cn(
            'group flex items-start gap-3 p-4 rounded-md shadow-lg min-w-[300px] max-w-md',
            'bg-card border border-border border-l-4',
            'data-[type=info]:border-l-primary',
            'data-[type=success]:border-l-success',
            'data-[type=warning]:border-l-warning',
            'data-[type=error]:border-l-destructive',
            'data-[type=info]:text-primary',
            'data-[type=success]:text-success',
            'data-[type=warning]:text-warning',
            'data-[type=error]:text-destructive',
            'chalk-animate-toast-in'
          ),
          title: 'text-sm font-medium text-foreground',
          description: 'text-sm text-muted-foreground',
          actionButton: 'mt-2 text-sm font-semibold text-foreground hover:underline focus:outline-none',
          closeButton: 'flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors',
        },
      }}
      className={cn(className)}
      style={themeVariables as React.CSSProperties}
    />
  );
});

NotificationStack.displayName = 'NotificationStack';

export { toast };
