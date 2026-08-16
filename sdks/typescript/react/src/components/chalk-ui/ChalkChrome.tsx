import { useId, useMemo, type CSSProperties } from "react";

import { generateChalkFill, generateChalkLayers, type ChalkShape } from "./shapes";
import { resolveSeed } from "./prng";
import { DEFAULT_CHALK_DIMENSIONS, usePrefersReducedMotion, useResizeObserver } from "./useResizeObserver";

export interface ChalkChromeProps {
  readonly shape?: ChalkShape;
  readonly seed?: number | string;
  readonly roughness?: number;
  readonly radius?: number;
  readonly stroke?: string;
  readonly fill?: string;
  readonly focusStroke?: string;
  readonly scribble?: boolean;
  readonly filled?: boolean;
  readonly boil?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly part?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}

function layerOpacity(layer: "fill" | "core" | "powder" | "edge" | "focus"): number {
  if (layer === "powder") return 0.3;
  if (layer === "edge") return 0.2;
  if (layer === "focus") return 0.55;
  return 1;
}

export function ChalkChrome({
  shape = "rect",
  seed,
  roughness = 1,
  radius = 8,
  stroke = "var(--chalk-stroke, var(--chalk-app-text, currentColor))",
  fill = "var(--chalk-fill, var(--chalk-app-control-primary, var(--chalk-accent, currentColor)))",
  focusStroke = "var(--chalk-focus, var(--chalk-app-control-active-line, currentColor))",
  scribble = false,
  filled = false,
  boil = true,
  width,
  height,
  part,
  className,
  style,
}: ChalkChromeProps) {
  const id = useId();
  const explicitDimensions = { width: width ?? DEFAULT_CHALK_DIMENSIONS.width, height: height ?? DEFAULT_CHALK_DIMENSIONS.height };
  const { ref, dimensions } = useResizeObserver<SVGSVGElement>(explicitDimensions);
  const reducedMotion = usePrefersReducedMotion();
  const resolvedSeed = resolveSeed(seed, id);
  // The frame structure stays stable for hydration; reduced motion keeps the same static first frame.
  const frameCount = boil ? 3 : 1;
  const shapeOptions = useMemo(() => ({ shape, width: dimensions.width, height: dimensions.height, radius, roughness, seed: resolvedSeed, frameCount, scribble }) as const, [dimensions.height, dimensions.width, frameCount, radius, roughness, resolvedSeed, shape, scribble]);
  const layers = useMemo(() => generateChalkLayers(shapeOptions), [shapeOptions]);
  const filledPath = useMemo(() => (filled && shape !== "line" && shape !== "check" ? generateChalkFill(shapeOptions) : undefined), [filled, shapeOptions]);

  return (
    <svg
      ref={ref}
      aria-hidden="true"
      focusable="false"
      className={className}
      data-chalk-chrome="true"
      data-chalk-part={part}
      data-chalk-static={reducedMotion ? "true" : undefined}
      height="100%"
      preserveAspectRatio="none"
      pointerEvents="none"
      style={{ ...style, pointerEvents: "none", overflow: "visible" }}
      viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
      width="100%"
      xmlns="http://www.w3.org/2000/svg"
    >
      {filledPath ? <path d={filledPath} data-chalk-layer="base-fill" fill={fill} fillOpacity="0.16" stroke="none" /> : null}
      {layers.map((layer, index) => {
        const layerStroke = layer.layer === "focus" ? focusStroke : stroke;
        const texture = layer.texture;
        const frameVisible = layer.layer === "focus" || layer.frame === 0;
        const dash = texture ? (layer.layer === "core" ? texture.coreDash : layer.layer === "powder" ? texture.powderDash : texture.edgeDash) : undefined;
        const opacity = layer.layer === "focus" ? 0 : frameVisible ? layerOpacity(layer.layer) * (texture ? Number(layer.layer === "core" ? texture.coreOpacity : layer.layer === "powder" ? texture.powderOpacity : texture.edgeOpacity) : 1) : 0;
        const transform = texture && layer.layer === "edge" ? `translate(${texture.edgeX} ${texture.edgeY})` : undefined;
        return (
          <path
            key={`${layer.layer}-${layer.frame}-${index}`}
            d={layer.d}
            data-chalk-frame={layer.frame}
            data-chalk-layer={layer.layer}
            className={layer.layer === "focus" ? "chalk-focus-path opacity-0 transition-opacity group-focus-visible:opacity-60 group-focus-within:opacity-60" : undefined}
            fill={layer.layer === "fill" ? fill : "none"}
            fillOpacity={layer.layer === "fill" ? 0.2 : undefined}
            opacity={opacity}
            pathLength={layer.pathLength}
            stroke={layer.layer === "fill" ? fill : layerStroke}
            strokeDasharray={dash}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={layer.layer === "focus" ? 1.35 : layer.layer === "powder" ? 1.25 : 1.7}
            transform={transform}
          />
        );
      })}
    </svg>
  );
}
