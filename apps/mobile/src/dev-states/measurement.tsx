import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Dimensions, PixelRatio, Platform, StyleSheet, Text, View, type TextProps, type TextStyle, type ViewProps, type ViewStyle } from "react-native";

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

function useMeasurement(testID: string, ref: RefObject<View | Text | null>, style: ViewStyle | TextStyle) {
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
    registry.set(testID, measure);
    return () => {
      registry.delete(testID);
    };
  }, [testID, measure]);
}

/** Declared props (expanded shorthands), not computed/inherited native styles. */
export function MeasuredView({ testID, style, ...props }: ViewProps & { testID: string }) {
  const ref = useRef<View>(null);
  useMeasurement(testID, ref, StyleSheet.flatten(style) ?? {});
  return <View {...props} testID={testID} style={style} ref={ref} collapsable={false} />;
}

export function MeasuredText({ testID, style, ...props }: TextProps & { testID: string }) {
  const ref = useRef<Text>(null);
  useMeasurement(testID, ref, StyleSheet.flatten(style) ?? {});
  return <Text {...props} testID={testID} style={style} ref={ref} />;
}

export async function sendMeasurements(endpoint: string, ids: string[], codes: string) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "10.0.2.2"].includes(url.hostname)) throw new Error("Measurement endpoint must be a local HTTP host");
  const measurements = Object.fromEntries(
    await Promise.all(
      ids.map(async (id) => {
        const read = registry.get(id);
        return [id, read ? await read() : { error: `Missing measured testID: ${id}` }];
      }),
    ),
  );
  const root = await registry.get("harness.ready")?.();
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codes, platform: Platform.OS, screen: Dimensions.get("screen"), scale: PixelRatio.get(), root, measurements }) });
  if (!response.ok) throw new Error(`Parity upload failed: ${response.status}`);
}
