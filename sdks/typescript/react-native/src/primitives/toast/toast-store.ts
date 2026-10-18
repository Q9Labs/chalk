import type { ReactNode } from "react";
import { durations } from "../../theme/tokens";
import { announce } from "../announce";

/** `info` leaves on its own after 5 s; `error` and `knock` stay until acted on or dismissed. */
export type ToastKind = "info" | "error" | "knock";

/** A message is plain text with optional bold runs, such as a person's name. */
export type MessagePart = string | { readonly strong: string };

export type ToastAction = {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: "primary" | "secondary";
  readonly testID?: string;
};

export type ToastInput = {
  readonly kind?: ToastKind;
  /** An icon or a small avatar in front of the message. */
  readonly leading?: ReactNode;
  readonly message: string | readonly MessagePart[];
  readonly actions?: readonly ToastAction[];
  /** Adds the close button; errors usually have one. */
  readonly dismissible?: boolean;
  /** Lets a long message wrap instead of trimming it to one line. */
  readonly wrap?: boolean;
  readonly testID?: string;
};

export type Toast = ToastInput & { readonly id: number; readonly kind: ToastKind };

export type ToastStore = {
  readonly show: (input: ToastInput) => number;
  readonly dismiss: (id: number) => void;
  readonly clear: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => readonly Toast[];
};

/** At most three notices show at once; a fourth pushes out the oldest. */
const MAX_VISIBLE = 3;

export function messageText(message: ToastInput["message"]): string {
  return typeof message === "string" ? message : message.map((part) => (typeof part === "string" ? part : part.strong)).join("");
}

export function createToastStore(): ToastStore {
  let toasts: readonly Toast[] = [];
  let nextId = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  const publish = (next: readonly Toast[]) => {
    toasts = next;
    for (const listener of listeners) listener();
  };
  const dismiss = (id: number) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (toasts.some((toast) => toast.id === id)) publish(toasts.filter((toast) => toast.id !== id));
  };
  return {
    show(input) {
      const toast: Toast = { ...input, id: ++nextId, kind: input.kind ?? "info" };
      const kept = toasts.slice(Math.max(0, toasts.length - (MAX_VISIBLE - 1)));
      for (const dropped of toasts.slice(0, toasts.length - kept.length)) dismiss(dropped.id);
      publish([...kept, toast]);
      if (toast.kind === "info")
        timers.set(
          toast.id,
          setTimeout(() => dismiss(toast.id), durations.toastInfo),
        );
      announce(messageText(toast.message));
      return toast.id;
    },
    dismiss,
    clear() {
      for (const toast of toasts) dismiss(toast.id);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => toasts,
  };
}
