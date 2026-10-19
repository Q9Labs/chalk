import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useReducedMotion, withTiming, type EntryExitAnimationFunction } from "react-native-reanimated";
import { useDeviceLayout } from "../../frame/device-layout";
import { usePortalCount } from "../../frame/portal";
import { timings } from "../../motion/motion";
import { Toast } from "./Toast";
import { createToastStore, type ToastStore } from "./toast-store";

const ToastContext = createContext<ToastStore | null>(null);

/** `bottom` is the height the stack keeps above the safe area; null means the call dock's clearance. */
type ToastClearance = { readonly bottom: number | null; readonly setBottom: (bottom: number | null) => void };
const ToastClearanceContext = createContext<ToastClearance | null>(null);

export function ToastProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [store] = useState(createToastStore);
  const [bottom, setBottom] = useState<number | null>(null);
  const clearance = useMemo<ToastClearance>(() => ({ bottom, setBottom }), [bottom]);
  return (
    <ToastContext.Provider value={store}>
      <ToastClearanceContext.Provider value={clearance}>{children}</ToastClearanceContext.Provider>
    </ToastContext.Provider>
  );
}

/** Shows and dismisses event notices: `const toasts = useToasts(); toasts.show({ message: [{ strong: "Nora" }, " joined"] })`. */
export function useToasts(): Pick<ToastStore, "show" | "dismiss" | "clear"> {
  const store = useContext(ToastContext);
  if (!store) throw new Error("useToasts must be used inside <Chalk>.");
  return store;
}

/**
 * Lifts the notices above a screen's own bottom controls, such as Home's buttons, which are taller
 * than the call dock. Call it with null when the screen unmounts.
 */
export function useToastClearance(): (bottom: number | null) => void {
  const clearance = useContext(ToastClearanceContext);
  if (!clearance) throw new Error("useToastClearance must be used inside <Chalk>.");
  return clearance.setBottom;
}

/**
 * The stack of notices, centred above the dock. While a phone sheet is up, the stack moves to
 * the top of the screen with the newest notice nearest the top edge, as in the mockup.
 */
export function ToastStack(): React.JSX.Element {
  const store = useContext(ToastContext);
  const clearance = useContext(ToastClearanceContext);
  if (!store || !clearance) throw new Error("ToastStack must be inside <Chalk>.");
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const layout = useDeviceLayout();
  const sheetUp = usePortalCount("sheets") > 0;
  const reduceMotion = useReducedMotion();
  const atTop = layout.phone && sheetUp;
  const offset = layout.arrangement === "pad" ? 88 : layout.arrangement === "landscape" ? 70 : 76;
  const position = atTop ? { top: layout.insets.top + 8, flexDirection: "column-reverse" as const } : { bottom: layout.insets.bottom + (clearance.bottom ?? offset) };

  return (
    <View pointerEvents="box-none" style={[styles.stack, position]} testID="frame.toasts">
      {toasts.map((toast) => (
        <Animated.View entering={reduceMotion ? undefined : toastEntering} exiting={reduceMotion ? undefined : toastExiting} key={toast.id} style={{ maxWidth: layout.width - 32 }}>
          <Toast onDismiss={() => store.dismiss(toast.id)} toast={toast} />
        </Animated.View>
      ))}
    </View>
  );
}

const toastEntering: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 8 }] },
    animations: { opacity: withTiming(1, timings.toastIn), transform: [{ translateY: withTiming(0, timings.toastIn) }] },
  };
};

const toastExiting: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: { opacity: withTiming(0, timings.toastOut), transform: [{ translateY: withTiming(4, timings.toastOut) }] },
  };
};

const styles = StyleSheet.create({
  stack: { position: "absolute", left: 0, right: 0, alignItems: "center", gap: 8 },
});
