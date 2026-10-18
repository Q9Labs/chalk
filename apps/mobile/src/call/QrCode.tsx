import { memo, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { encode } from "uqr";

/** Quiet zone around the code, in modules, as the mockup draws it. */
const QUIET = 2;
/** Black on white in both themes, so any camera reads it. */
const PAPER = "#FFFFFF";
const INK = "#000000";

/** A QR code for `value`, 112 pt square with rounded corners (`svg.qr`). */
export const QrCode = memo(function QrCode({ value }: { readonly value: string }): React.JSX.Element {
  const { path, size } = useMemo(() => {
    const { data } = encode(value, { border: 0 });
    // One run of dark modules per segment keeps the path short.
    const runs = data.flatMap((row, y) => {
      const segments: string[] = [];
      let start = -1;
      row.forEach((dark, x) => {
        if (dark && start < 0) start = x;
        if ((!dark || x === row.length - 1) && start >= 0) {
          const end = dark ? x + 1 : x;
          segments.push(`M${start} ${y}h${end - start}v1h${start - end}z`);
          start = -1;
        }
      });
      return segments;
    });
    return { path: runs.join(""), size: data.length };
  }, [value]);
  const box = size + QUIET * 2;

  return (
    <View accessibilityLabel="QR code for this call’s link" accessibilityRole="image" style={styles.frame}>
      <Svg height={112} viewBox={`${-QUIET} ${-QUIET} ${box} ${box}`} width={112}>
        <Rect fill={PAPER} height={box} width={box} x={-QUIET} y={-QUIET} />
        <Path d={path} fill={INK} />
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  frame: { width: 112, height: 112, borderRadius: 8, overflow: "hidden" },
});
