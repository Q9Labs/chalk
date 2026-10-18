import { memo, useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { encode } from "uqr";
import { fixed } from "../theme/tokens";

/** The call link as a QR code (`svg.qr`): black on white with a two-module quiet zone, in both themes. */
export const QrCode = memo(function QrCode({ value, size }: { readonly value: string; readonly size: number }): React.JSX.Element {
  const { path, modules } = useMemo(() => {
    const { data, size: count } = encode(value, { ecc: "M", border: 2 });
    // One rectangle per run of dark modules in a row, so no antialiased seams show between them.
    let d = "";
    data.forEach((row, y) => {
      let start = -1;
      row.forEach((dark, x) => {
        if (dark && start < 0) start = x;
        if (start >= 0 && (!dark || x === row.length - 1)) {
          const end = dark ? x + 1 : x;
          d += `M${start} ${y}h${end - start}v1h${start - end}z`;
          start = -1;
        }
      });
    });
    return { path: d, modules: count };
  }, [value]);
  return (
    <View accessibilityLabel={`QR code for ${value}`} accessibilityRole="image" accessible style={{ width: size, height: size, borderRadius: 8, overflow: "hidden" }} testID="details.qr">
      <Svg height={size} viewBox={`0 0 ${modules} ${modules}`} width={size}>
        <Rect fill={fixed.qrLight} height={modules} width={modules} x={0} y={0} />
        <Path d={path} fill={fixed.qrDark} />
      </Svg>
    </View>
  );
});
