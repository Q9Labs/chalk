import type { MeasurementRegistry } from "@q9labsai/chalk-react-native/dev";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Dimensions, KeyboardAvoidingView, PixelRatio, Platform, StyleSheet, View, type KeyboardAvoidingViewProps, type TextStyle, type ViewProps, type ViewStyle } from "react-native";

type Measurement = { frame: { x: number; y: number; width: number; height: number }; style: ReturnType<typeof StyleSheet.flatten> };
const registry = new Map<string, () => Promise<Measurement>>();

function expanded(style: ViewStyle | TextStyle) {
  return {
    backgroundColor: "transparent",
    borderRadius: 0,
    borderWidth: 0,
    borderColor: "transparent",
    opacity: 1,
    ...style,
    paddingTop: style.paddingTop ?? style.paddingVertical ?? style.padding ?? 0,
    paddingBottom: style.paddingBottom ?? style.paddingVertical ?? style.padding ?? 0,
    paddingLeft: style.paddingLeft ?? style.paddingHorizontal ?? style.padding ?? 0,
    paddingRight: style.paddingRight ?? style.paddingHorizontal ?? style.padding ?? 0,
  };
}

export const registerSDKMeasurement: MeasurementRegistry = (testID, read) => {
  const measure = async () => {
    const value = await read();
    return { frame: value.frame, style: expanded(value.style) };
  };
  registry.set(testID, measure);
  return () => {
    if (registry.get(testID) === measure) registry.delete(testID);
  };
};

function useMeasurement(testID: string | undefined, ref: RefObject<Pick<View, "measureInWindow"> | null>, style: ViewStyle | TextStyle) {
  const measure = useCallback(
    () =>
      new Promise<Measurement>((resolve, reject) => {
        if (!ref.current) {
          reject(new Error(`Unmounted testID: ${testID}`));
          return;
        }
        ref.current.measureInWindow((x, y, width, height) => resolve({ frame: { x, y, width, height }, style: expanded(style) }));
      }),
    [style, testID],
  );
  useEffect(() => {
    if (!testID) return;
    registry.set(testID, measure);
    return () => {
      if (registry.get(testID) === measure) registry.delete(testID);
    };
  }, [testID, measure]);
}

/** Declared props (expanded shorthands), not computed/inherited native styles. */
export function MeasuredView({ testID, style, ...props }: ViewProps) {
  const ref = useRef<View>(null);
  useMeasurement(testID, ref, StyleSheet.flatten(style) ?? {});
  return <View {...props} testID={testID} style={style} ref={ref} collapsable={false} />;
}

export function MeasuredKeyboardAvoidingView({ testID, style, ...props }: KeyboardAvoidingViewProps) {
  const ref = useRef<KeyboardAvoidingView>(null);
  useMeasurement(testID, ref, StyleSheet.flatten(style) ?? {});
  return <KeyboardAvoidingView {...props} testID={testID} style={style} ref={ref} />;
}

async function readMeasurement(id: string) {
  const read = registry.get(id);
  if (!read) return { error: `Missing measured testID: ${id}` };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Native measurement timed out: ${id}`)), 1500);
      }),
    ]);
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendMeasurements(endpoint: string, ids: string[], codes: string, surface: "app" | "sdk" = "sdk") {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "10.0.2.2"].includes(url.hostname)) throw new Error("Measurement endpoint must be a local HTTP host");
  // Registration alone doesn't mean Android's native view has mounted after a cold reload.
  const deadline = Date.now() + 60000;
  let screen = await readMeasurement("frame.screen");
  while (("error" in screen || screen.frame.width <= 0 || screen.frame.height <= 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    screen = await readMeasurement("frame.screen");
  }
  const measurements = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await readMeasurement(id)])));
  const root = await readMeasurement("harness.ready");
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codes, surface, platform: Platform.OS, screen: Dimensions.get("screen"), scale: PixelRatio.get(), root, measurements }) });
  if (!response.ok) throw new Error(`Parity upload failed: ${response.status}`);
}
