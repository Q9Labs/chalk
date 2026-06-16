import type { ReactNode } from "react";
import Svg, { Defs, G, Path, RadialGradient, Rect, Stop, Text as SvgText } from "react-native-svg";
import type { FacehashScene, Variant } from "./core/index.js";
import { useBlinkTransform } from "./native-blink.js";

type FacehashSceneSvgNativeProps = {
  backgroundColor: string;
  enableBlink?: boolean;
  idPrefix: string;
  scene: FacehashScene;
  showInitial: boolean;
  size: number;
  variant: Variant;
};

function renderEye(paths: string[], transform: string | undefined): ReactNode {
  return (
    <G transform={transform}>
      {paths.map((path) => (
        <Path d={path} fill="white" key={path} />
      ))}
    </G>
  );
}

export function FacehashSceneSvgNative({ backgroundColor, enableBlink = false, idPrefix, scene, showInitial, size, variant }: FacehashSceneSvgNativeProps): React.JSX.Element {
  const leftBlinkTransform = useBlinkTransform(enableBlink, scene.data.blinkTimings.left, scene.faceGeometry.leftEyeAnchor);
  const rightBlinkTransform = useBlinkTransform(enableBlink, scene.data.blinkTimings.right, scene.faceGeometry.rightEyeAnchor);
  const gradientId = `${idPrefix}-gradient`;

  return (
    <Svg fill="none" height={size} viewBox="0 0 100 100" width={size}>
      <Defs>
        <RadialGradient cx={`${scene.gradientCenter.x}%`} cy={`${scene.gradientCenter.y}%`} id={gradientId} r="70%">
          <Stop offset="0%" stopColor="#ffffff" stopOpacity={0.15} />
          <Stop offset="60%" stopColor="#ffffff" stopOpacity={0} />
        </RadialGradient>
      </Defs>

      <Rect fill={backgroundColor} height="100" width="100" x="0" y="0" />
      {variant === "gradient" ? <Rect fill={`url(#${gradientId})`} height="100" width="100" x="0" y="0" /> : null}

      <G transform={scene.projection.svgTransform}>
        <G transform={`translate(${scene.faceBox.x} ${scene.faceBox.y}) scale(${scene.faceBox.width / scene.faceGeometry.viewBox.width} ${scene.faceBox.height / scene.faceGeometry.viewBox.height})`}>
          {renderEye(scene.faceGeometry.leftEyePaths, leftBlinkTransform)}
          {renderEye(scene.faceGeometry.rightEyePaths, rightBlinkTransform)}
        </G>

        {showInitial ? (
          <SvgText alignmentBaseline="middle" fill="white" fontFamily="monospace" fontSize={scene.initialLayout.fontSize} fontWeight="700" textAnchor="middle" x={scene.initialLayout.x} y={scene.initialLayout.y}>
            {scene.data.initial}
          </SvgText>
        ) : null}
      </G>
    </Svg>
  );
}
