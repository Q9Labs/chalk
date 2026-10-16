import React from "react";
import { ClassicControlBar, ClassicControlBarSurface } from "./ClassicControlBar";
import { type ControlBarProps, type ControlBarSurfaceProps } from "./control-bar-behavior";

export type { ControlBarProps, ControlBarButtonName } from "./control-bar-behavior";

export const ControlBarSurface = ClassicControlBarSurface;

export function ControlBar(props: ControlBarProps): React.JSX.Element {
  return <ClassicControlBar {...props} />;
}

/** State-driven controls presentation without device, permission or Space hooks. */
export function ControlBarPresentation(props: ControlBarSurfaceProps): React.JSX.Element {
  const surfaceProps: ControlBarSurfaceProps = props.displayOnly ? { ...props, detectDevices: false } : props;
  return <ClassicControlBarSurface {...surfaceProps} />;
}

ControlBar.displayName = "ControlBar";
ControlBarPresentation.displayName = "ControlBarPresentation";
