import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { createFacehashScene, getColor, type Intensity3D, type Variant } from "./core";
import { FacehashSceneSvgNative } from "./FacehashSceneSvg.native";

export interface FacehashNativeProps {
  name: string;
  size?: number;
  variant?: Variant;
  intensity3d?: Intensity3D;
  interactive?: boolean;
  showInitial?: boolean;
  colors?: readonly string[];
  enableBlink?: boolean;
  renderMouth?: () => React.ReactNode;
  testID?: string;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function FacehashNative({ name, size = 40, variant = "gradient", intensity3d = "dramatic", interactive = true, showInitial = true, colors, enableBlink = false, renderMouth, testID }: FacehashNativeProps): React.JSX.Element {
  const [isPressed, setIsPressed] = React.useState(false);
  const colorsLength = colors?.length ?? 1;
  const scene = React.useMemo(
    () =>
      createFacehashScene({
        name,
        colorsLength,
        intensity3d,
        pose: isPressed && interactive ? "front" : "seed",
      }),
    [colorsLength, intensity3d, interactive, isPressed, name],
  );
  const backgroundColor = getColor(colors, scene.data.colorIndex);
  const idPrefix = React.useMemo(() => sanitizeId(`facehash-native-${name}`), [name]);

  return (
    <Pressable onPressIn={interactive ? () => setIsPressed(true) : undefined} onPressOut={interactive ? () => setIsPressed(false) : undefined} style={[styles.container, { width: size, height: size, borderRadius: size / 2, backgroundColor }]} testID={testID}>
      <FacehashSceneSvgNative backgroundColor={backgroundColor} enableBlink={enableBlink} idPrefix={idPrefix} scene={scene} showInitial={showInitial && !renderMouth} size={size} variant={variant} />
      {renderMouth ? <View style={styles.mouth}>{renderMouth()}</View> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    position: "relative",
  },
  mouth: {
    alignItems: "center",
    height: "100%",
    justifyContent: "center",
    pointerEvents: "none",
    position: "absolute",
    width: "100%",
    top: "70%",
  },
});
