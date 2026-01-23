import React, { useEffect } from 'react';
import { Toaster, toast } from 'sonner';
import { cn } from '../../utils/cn';

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
  className,
}) => {
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
      richColors
      position={positionMap[position]}
      visibleToasts={maxVisible}
      className={cn(className)}
      toastOptions={{
        classNames: {
          toast: cn(
            'bg-card',
            'text-card-foreground',
            'border-border'
          ),
        },
      }}
    />
  );
});

NotificationStack.displayName = 'NotificationStack';

export { toast };
