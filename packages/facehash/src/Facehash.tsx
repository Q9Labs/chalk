import * as React from "react";
import { createFacehashScene, getColor, type Intensity3D, type Variant } from "./core";
import { FacehashSceneSvg } from "./FacehashSceneSvg";

export interface FacehashProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  name: string;
  size?: number | string;
  variant?: Variant;
  intensity3d?: Intensity3D;
  interactive?: boolean;
  showInitial?: boolean;
  colors?: readonly string[];
  enableBlink?: boolean;
  renderMouth?: () => React.ReactNode;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export const Facehash = React.forwardRef<HTMLDivElement, FacehashProps>(function Facehash(
  { name, size = 40, variant = "gradient", intensity3d = "dramatic", interactive = true, showInitial = true, colors, enableBlink = false, renderMouth, className, style, onMouseEnter, onMouseLeave, ...props },
  ref,
): React.JSX.Element {
  const [isHovered, setIsHovered] = React.useState(false);
  const reactId = React.useId();
  const colorsLength = colors?.length ?? 1;
  const scene = React.useMemo(
    () =>
      createFacehashScene({
        name,
        colorsLength,
        intensity3d,
        pose: isHovered && interactive ? "front" : "seed",
      }),
    [colorsLength, intensity3d, interactive, isHovered, name],
  );
  const backgroundColor = getColor(colors, scene.data.colorIndex);
  const sizeValue = typeof size === "number" ? `${size}px` : size;
  const svgIdPrefix = React.useMemo(() => sanitizeId(`facehash-${reactId}-${name}`), [name, reactId]);

  return (
    <div
      className={className}
      data-facehash=""
      data-interactive={interactive || undefined}
      onMouseEnter={(event) => {
        if (interactive) {
          setIsHovered(true);
        }
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        if (interactive) {
          setIsHovered(false);
        }
        onMouseLeave?.(event);
      }}
      ref={ref}
      style={{
        alignItems: "center",
        backgroundColor,
        color: "#ffffff",
        display: "flex",
        height: sizeValue,
        justifyContent: "center",
        overflow: "hidden",
        position: "relative",
        width: sizeValue,
        ...style,
      }}
      {...props}
    >
      <FacehashSceneSvg backgroundColor={backgroundColor} enableBlink={enableBlink} height="100%" idPrefix={svgIdPrefix} scene={scene} showInitial={showInitial && !renderMouth} variant={variant} width="100%" withAnimatedProjection={interactive} />

      {renderMouth ? (
        <div
          data-facehash-mouth=""
          style={{
            alignItems: "center",
            display: "flex",
            inset: 0,
            justifyContent: "center",
            left: "50%",
            pointerEvents: "none",
            position: "absolute",
            top: "70%",
            transform: "translate(-50%, -50%)",
            zIndex: 1,
          }}
        >
          {renderMouth()}
        </div>
      ) : null}
    </div>
  );
});
