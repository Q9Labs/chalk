import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { ReduceMotion, useReducedMotion, withTiming, type EntryExitAnimationFunction } from "react-native-reanimated";
import { useDeviceLayout } from "../../frame/device-layout";
import { usePortalEntries } from "../../frame/portal";
import { timings } from "../../motion/motion";
import { Toast } from "./Toast";
import { createToastStore, type ToastStore } from "./toast-store";

const ToastContext = createContext<ToastStore | null>(null);

export function ToastProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [store] = useState(createToastStore);
  return <ToastContext.Provider value={store}>{children}</ToastContext.Provider>;
}

/** Shows and dismisses event notices: `const toasts = useToasts(); toasts.show({ message: [{ strong: "Nora" }, " joined"] })`. */
export function useToasts(): Pick<ToastStore, "show" | "dismiss" | "clear"> {
  const store = useContext(ToastContext);
  if (!store) throw new Error("useToasts must be used inside <Chalk>.");
  return store;
}

/**
 * The stack of notices, centred above the dock. While a phone sheet is up, the stack moves to
 * the top of the screen with the newest notice nearest the top edge, as in the mockup.
 */
export function ToastStack(): React.JSX.Element {
  const store = useContext(ToastContext);
  if (!store) throw new Error("ToastStack must be inside <Chalk>.");
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const layout = useDeviceLayout();
  const sheetUp = usePortalEntries("sheets").length > 0;
  const reduceMotion = useReducedMotion();
  const atTop = layout.phone && sheetUp;
  const offset = layout.arrangement === "pad" ? 88 : layout.arrangement === "landscape" ? 70 : 76;
  const position = atTop ? { top: layout.insets.top + 8, flexDirection: "column-reverse" as const } : { bottom: layout.insets.bottom + offset };

  return (
    <View pointerEvents="box-none" style={[styles.stack, position]} testID="frame.toasts">
      {toasts.map((toast) => (
        <Animated.View entering={reduceMotion ? fadeIn : toastEntering} exiting={reduceMotion ? fadeOut : toastExiting} key={toast.id} style={{ maxWidth: layout.width - 32 }}>
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

const fadeIn: EntryExitAnimationFunction = () => {
  "worklet";
  return { initialValues: { opacity: 0 }, animations: { opacity: withTiming(1, { ...timings.toastIn, reduceMotion: ReduceMotion.Never }) } };
};

const fadeOut: EntryExitAnimationFunction = () => {
  "worklet";
  return { initialValues: { opacity: 1 }, animations: { opacity: withTiming(0, { ...timings.toastOut, reduceMotion: ReduceMotion.Never }) } };
};

const styles = StyleSheet.create({
  stack: { position: "absolute", left: 0, right: 0, alignItems: "center", gap: 8 },
});
