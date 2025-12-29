import React from 'react';
import { cn } from '../../utils/cn';
import { Toast } from '../atomic/Toast';

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

export const NotificationStack: React.FC<NotificationStackProps> = ({
  notifications,
  onDismiss,
  position = 'top-right',
  maxVisible = 5,
  className,
}) => {
  const visibleNotifications = notifications.slice(0, maxVisible);

  const positionClasses = {
    'top-right': 'top-4 right-4 items-end',
    'top-left': 'top-4 left-4 items-start',
    'bottom-right': 'bottom-4 right-4 items-end',
    'bottom-left': 'bottom-4 left-4 items-start',
  };

  return (
    <div
      className={cn(
        'fixed flex flex-col gap-2 z-50 pointer-events-none p-4',
        positionClasses[position],
        className
      )}
      role="region"
      aria-label="Notifications"
    >
      {visibleNotifications.map((notification) => (
        <div key={notification.id} className="pointer-events-auto transition-all duration-300 ease-in-out">
          <Toast
            message={notification.message}
            type={notification.type}
            duration={notification.duration}
            action={notification.action}
            onDismiss={() => onDismiss(notification.id)}
          />
        </div>
      ))}
    </div>
  );
};
