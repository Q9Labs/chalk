import Svg, { Circle, G, Path } from "react-native-svg";
import { MARK } from "./mark";

/** The Chalk mark in one colour, `size` points square. Decorative. */
export function ChalkMark({ size, color }: { readonly size: number; readonly color: string }): React.JSX.Element {
  return (
    <Svg accessibilityElementsHidden height={size} importantForAccessibility="no-hide-descendants" viewBox={`0 0 ${MARK.viewBox} ${MARK.viewBox}`} width={size}>
      <G rotation={MARK.rotation} originX={MARK.viewBox / 2} originY={MARK.viewBox / 2}>
        <Path d={MARK.stick} fill={color} />
        <Path d={MARK.cap} fill={color} opacity={MARK.capOpacity} />
      </G>
      {MARK.dust.map(([cx, cy, r, opacity]) => (
        <Circle cx={cx} cy={cy} fill={color} key={`${cx},${cy}`} opacity={opacity} r={r} />
      ))}
    </Svg>
  );
}
