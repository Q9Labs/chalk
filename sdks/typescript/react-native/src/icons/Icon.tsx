import { memo } from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import type { IconElement } from "./icon-element";
import { iconElements } from "./icon-paths";

export type IconName = keyof typeof iconElements;

export type IconProps = {
  readonly name: IconName;
  readonly color: string;
  /** The mockup draws icons at 20 pt by default, 16 to 18 pt in tags and menus. */
  readonly size?: number;
  readonly strokeWidth?: number;
};

/** One icon from the mockup's 24-unit, 1.75-stroke line set. Icons are decorative; label the control that holds them. */
export const Icon = memo(function Icon({ name, color, size = 20, strokeWidth = 1.75 }: IconProps): React.JSX.Element {
  return (
    <Svg accessibilityElementsHidden fill="none" height={size} importantForAccessibility="no-hide-descendants" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} viewBox="0 0 24 24" width={size}>
      {iconElements[name].map((element: IconElement, index) => renderElement(element, index, color))}
    </Svg>
  );
});

function renderElement(element: IconElement, key: number, color: string): React.JSX.Element {
  const shared = { fill: element.fill === "currentColor" ? color : "none", strokeWidth: element.strokeWidth, transform: element.transform };
  switch (element.kind) {
    case "path":
      return <Path key={key} {...shared} d={element.d} />;
    case "rect":
      return <Rect key={key} {...shared} height={element.height} rx={element.rx} width={element.width} x={element.x} y={element.y} />;
    case "circle":
      return <Circle key={key} {...shared} cx={element.cx} cy={element.cy} r={element.r} />;
  }
}
