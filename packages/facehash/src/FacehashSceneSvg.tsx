import type * as React from "react";
import { ensureBlinkKeyframes, getBlinkStyle } from "./blink.js";
import type { FacehashScene, Variant } from "./core/index.js";

type FacehashSceneSvgProps = {
  backgroundColor: string;
  enableBlink?: boolean;
  height?: number | string;
  idPrefix: string;
  scene: FacehashScene;
  showInitial: boolean;
  style?: React.CSSProperties;
  variant: Variant;
  width?: number | string;
  withAnimatedProjection?: boolean;
};

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function FacehashSceneSvg({ backgroundColor, enableBlink = false, height = "100%", idPrefix, scene, showInitial, style, variant, width = "100%", withAnimatedProjection = false }: FacehashSceneSvgProps): React.JSX.Element {
  if (enableBlink) {
    ensureBlinkKeyframes();
  }

  const gradientId = `${sanitizeId(idPrefix)}-gradient`;
  const projectionStyle = withAnimatedProjection
    ? {
        transformBox: "view-box" as const,
        transformOrigin: "50% 50%",
        transform: scene.projection.cssTransform,
        transition: "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
      }
    : undefined;

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={height}
      style={{
        color: "inherit",
        display: "block",
        overflow: "visible",
        ...style,
      }}
      viewBox="0 0 100 100"
      width={width}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient cx={`${scene.gradientCenter.x}%`} cy={`${scene.gradientCenter.y}%`} id={gradientId} r="70%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.15" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect fill={backgroundColor} height="100" width="100" x="0" y="0" />
      {variant === "gradient" ? <rect fill={`url(#${gradientId})`} height="100" width="100" x="0" y="0" /> : null}

      <g style={projectionStyle} transform={scene.projection.svgTransform}>
        <g transform={`translate(${scene.faceBox.x} ${scene.faceBox.y}) scale(${scene.faceBox.width / scene.faceGeometry.viewBox.width} ${scene.faceBox.height / scene.faceGeometry.viewBox.height})`}>
          <g style={getBlinkStyle(enableBlink, scene.data.blinkTimings.left)}>
            {scene.faceGeometry.leftEyePaths.map((path) => (
              <path d={path} fill="currentColor" key={path} />
            ))}
          </g>
          <g style={getBlinkStyle(enableBlink, scene.data.blinkTimings.right)}>
            {scene.faceGeometry.rightEyePaths.map((path) => (
              <path d={path} fill="currentColor" key={path} />
            ))}
          </g>
        </g>

        {showInitial ? (
          <text dominantBaseline="middle" fill="currentColor" fontFamily="monospace" fontSize={scene.initialLayout.fontSize} fontWeight="700" textAnchor="middle" x={scene.initialLayout.x} y={scene.initialLayout.y}>
            {scene.data.initial}
          </text>
        ) : null}
      </g>
    </svg>
  );
}
