import { memo } from "react";
import { ChalkToast, type ChalkToastProps } from "../chalk-ui/ChalkToast";
import { cn } from "../../utils/cn";
export interface Toast extends Omit<ChalkToastProps, "onDismiss"> {
  readonly id: string;
}
export interface ToastStackProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
  readonly maxVisible?: number;
  readonly className?: string;
}
export const ToastStack = memo(function ToastStack({ toasts, onDismiss, maxVisible = 3, className }: ToastStackProps) {
  return (
    <div data-part="toast-stack" className={cn("chalk-toasts", className)}>
      {toasts.slice(-maxVisible).map((toast) => (
        <ChalkToast key={toast.id} {...toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
});
