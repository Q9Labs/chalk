"use client";

import * as React from "react";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";

import { resolvePortalThemeFromDocument } from "./lib/theme";
import { cn } from "./lib/utils";

export type ToastType = "neutral" | "info" | "success" | "warning" | "error" | "danger";

export interface ToastOptions {
  actionProps?: React.ComponentPropsWithoutRef<"button">;
  data?: Record<string, unknown>;
  description?: React.ReactNode;
  id?: string;
  onClose?: () => void;
  priority?: "low" | "high";
  timeout?: number;
  title?: React.ReactNode;
  type?: ToastType;
}

const sharedToastManager = ToastPrimitive.createToastManager();

export const toastManager = sharedToastManager;

export const toast = Object.assign((options: ToastOptions) => sharedToastManager.add(options), {
  danger: (options: Omit<ToastOptions, "type">) => sharedToastManager.add({ ...options, type: "danger" }),
  dismiss: (id?: string) => sharedToastManager.close(id),
  error: (options: Omit<ToastOptions, "type">) => sharedToastManager.add({ ...options, type: "error" }),
  info: (options: Omit<ToastOptions, "type">) => sharedToastManager.add({ ...options, type: "info" }),
  success: (options: Omit<ToastOptions, "type">) => sharedToastManager.add({ ...options, type: "success" }),
  warning: (options: Omit<ToastOptions, "type">) => sharedToastManager.add({ ...options, type: "warning" }),
});

function ToastProvider({ toastManager: manager = sharedToastManager, ...props }: React.ComponentProps<typeof ToastPrimitive.Provider>) {
  return <ToastPrimitive.Provider toastManager={manager} {...props} />;
}

const ToastRoot = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root>>(function ToastRoot({ className, toast: toastObject, ...props }, ref) {
  return <ToastPrimitive.Root ref={ref} data-slot="toast" data-type={toastObject.type ?? "neutral"} toast={toastObject} className={cn("chalk-ui-toast", className)} {...props} />;
});

const ToastContent = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Content>>(function ToastContent({ className, ...props }, ref) {
  return <ToastPrimitive.Content ref={ref} data-slot="toast-content" className={cn("chalk-ui-toast-content", className)} {...props} />;
});

const ToastTitle = React.forwardRef<HTMLHeadingElement, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>>(function ToastTitle({ className, ...props }, ref) {
  return <ToastPrimitive.Title ref={ref} data-slot="toast-title" className={cn("chalk-ui-toast-title", className)} {...props} />;
});

const ToastDescription = React.forwardRef<HTMLParagraphElement, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>>(function ToastDescription({ className, ...props }, ref) {
  return <ToastPrimitive.Description ref={ref} data-slot="toast-description" className={cn("chalk-ui-toast-description", className)} {...props} />;
});

const ToastClose = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>>(function ToastClose({ "aria-label": ariaLabel = "Dismiss notification", children = "×", className, ...props }, ref) {
  return (
    <ToastPrimitive.Close ref={ref} aria-label={ariaLabel} data-slot="toast-close" className={cn("chalk-ui-toast-close chalk-ui-focusable", className)} {...props}>
      {children}
    </ToastPrimitive.Close>
  );
});

const ToastAction = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof ToastPrimitive.Action>>(function ToastAction({ className, ...props }, ref) {
  return <ToastPrimitive.Action ref={ref} data-slot="toast-action" className={cn("chalk-ui-focusable", className)} {...props} />;
});

function ToastViewport({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>) {
  const { toasts } = ToastPrimitive.useToastManager();
  const portalTheme = resolvePortalThemeFromDocument();

  return (
    <ToastPrimitive.Viewport data-chalk data-chalk-theme={portalTheme} data-slot="toast-viewport" className={cn("chalk-ui-root chalk-ui-toast-viewport", className)} {...props}>
      {children}
      {toasts.map((toastObject) => {
        const actionProps = toastObject.actionProps;
        const { children: actionLabel, ...restActionProps } = actionProps ?? {};

        return (
          <ToastPrimitive.Root key={toastObject.id} data-slot="toast" data-type={toastObject.type ?? "neutral"} toast={toastObject} className="chalk-ui-toast">
            <ToastPrimitive.Content data-slot="toast-content" className="chalk-ui-toast-content">
              {toastObject.title ? (
                <ToastPrimitive.Title data-slot="toast-title" className="chalk-ui-toast-title">
                  {toastObject.title}
                </ToastPrimitive.Title>
              ) : null}
              {toastObject.description ? (
                <ToastPrimitive.Description data-slot="toast-description" className="chalk-ui-toast-description">
                  {toastObject.description}
                </ToastPrimitive.Description>
              ) : null}
              {actionProps ? (
                <ToastPrimitive.Action data-slot="toast-action" className="chalk-ui-focusable" {...restActionProps}>
                  {actionLabel ?? "Action"}
                </ToastPrimitive.Action>
              ) : null}
            </ToastPrimitive.Content>
            <ToastPrimitive.Close aria-label="Dismiss notification" data-slot="toast-close" className="chalk-ui-toast-close chalk-ui-focusable">
              ×
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
    </ToastPrimitive.Viewport>
  );
}

function useToast<Data extends object = Record<string, unknown>>() {
  return ToastPrimitive.useToastManager<Data>();
}

const Toast = Object.assign(ToastRoot, {
  Action: ToastAction,
  Close: ToastClose,
  Content: ToastContent,
  Description: ToastDescription,
  Provider: ToastProvider,
  Root: ToastRoot,
  Title: ToastTitle,
  Viewport: ToastViewport,
});

export type ToastRootProps = React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root>;

export { Toast, ToastAction, ToastClose, ToastContent, ToastDescription, ToastProvider, ToastRoot, ToastTitle, ToastViewport, useToast };
