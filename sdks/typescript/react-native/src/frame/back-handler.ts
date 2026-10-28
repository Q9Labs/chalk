import { useEffect, useRef } from "react";
import { BackHandler } from "react-native";

/**
 * While `active`, Android's back gesture calls `onBack` and stops there. Handlers run newest
 * first, so the sheet or menu opened last closes first.
 */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [subscription] Consume hardware Back while this layer is active; remove the native subscription when inactive.
  useEffect(() => {
    if (!active) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      latest.current();
      return true;
    });
    return () => subscription.remove();
  }, [active]);
}
