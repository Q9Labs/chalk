import { useEffect, useRef, type RefObject } from "react";
import { StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

export type MeasuredFrame = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** A host view's frame in window points and the style it declares at rest (animated values excluded). */
export type Measurement = { readonly frame: MeasuredFrame; readonly style: TextStyle };

/** Receives each measured testID while it's mounted; returns the function that forgets it. */
export type MeasurementRegistry = (testID: string, measure: () => Promise<Measurement>) => () => void;

type MeasurableNode = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void };

let registry: MeasurementRegistry | null = null;

/**
 * Development tooling only: the app's parity harness installs a registry before it renders
 * `Chalk`, and the call's regions and primitives report their frames and declared styles to it.
 * Nothing is measured while no registry is installed.
 */
export function setMeasurementRegistry(next: MeasurementRegistry | null): void {
  registry = next;
}

/** A ref for the host view that carries `testID`; attach it to that view. */
export function useMeasuredRef<TNode extends MeasurableNode>(testID: string | undefined, style: StyleProp<ViewStyle | TextStyle>): RefObject<TNode | null> {
  const ref = useRef<TNode>(null);
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing native measurement registry lifetime.
  useEffect(() => {
    if (!registry || !testID) return;
    const declared = StyleSheet.flatten(style) ?? {};
    return registry(
      testID,
      () =>
        new Promise((resolve, reject) => {
          if (!ref.current) {
            reject(new Error(`Unmounted testID: ${testID}`));
            return;
          }
          ref.current.measureInWindow((x, y, width, height) => resolve({ frame: { x, y, width, height }, style: declared }));
        }),
    );
  }, [style, testID]);
  return ref;
}
