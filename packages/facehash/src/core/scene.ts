import type { FaceGeometry } from "./face-geometry";
import { FACE_GEOMETRIES } from "./face-geometry";
import { computeFacehash, type FacehashData } from "./facehash-data";

export type Intensity3D = "none" | "subtle" | "medium" | "dramatic";

export type FacehashPose = "seed" | "front";

export type FacehashProjection = {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
  cssTransform: string;
  svgTransform: string;
};

export type FacehashScene = {
  data: FacehashData;
  faceGeometry: FaceGeometry;
  projection: FacehashProjection;
  gradientCenter: {
    x: number;
    y: number;
  };
  faceBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  initialLayout: {
    x: number;
    y: number;
    fontSize: number;
  };
  pose: FacehashPose;
};

export type CreateFacehashSceneOptions = {
  name: string;
  colorsLength?: number;
  intensity3d?: Intensity3D;
  pose?: FacehashPose;
};

type ProjectionPreset = {
  translate: number;
  compress: number;
  skewX: number;
  skewY: number;
  gradientShift: number;
};

const PROJECTION_PRESETS: Record<Intensity3D, ProjectionPreset> = {
  none: { translate: 0, compress: 0, skewX: 0, skewY: 0, gradientShift: 0 },
  subtle: { translate: 2.25, compress: 0.035, skewX: 1.5, skewY: 0.75, gradientShift: 2.5 },
  medium: { translate: 3.5, compress: 0.055, skewX: 2.5, skewY: 1.25, gradientShift: 4 },
  dramatic: { translate: 5, compress: 0.08, skewX: 3.5, skewY: 1.75, gradientShift: 6 },
};

const FACE_WIDTH = 60;
const FACE_CENTER_Y = 37;
const INITIAL_Y = 70;
const INITIAL_FONT_SIZE = 26;

function toFixedNumber(value: number): number {
  return Number(value.toFixed(3));
}

function formatPercent(value: number): string {
  return `${toFixedNumber(value)}%`;
}

function formatDegrees(value: number): string {
  return `${toFixedNumber(value)}deg`;
}

function buildCssTransform(projection: Omit<FacehashProjection, "cssTransform" | "svgTransform">): string {
  return [`translate(${formatPercent(projection.translateX)}, ${formatPercent(projection.translateY)})`, `skew(${formatDegrees(projection.skewX)}, ${formatDegrees(projection.skewY)})`, `scale(${toFixedNumber(projection.scaleX)}, ${toFixedNumber(projection.scaleY)})`].join(" ");
}

function buildSvgTransform(projection: Omit<FacehashProjection, "cssTransform" | "svgTransform">): string {
  return [
    `translate(${toFixedNumber(projection.translateX)} ${toFixedNumber(projection.translateY)})`,
    "translate(50 50)",
    `skewX(${toFixedNumber(projection.skewX)})`,
    `skewY(${toFixedNumber(projection.skewY)})`,
    `scale(${toFixedNumber(projection.scaleX)} ${toFixedNumber(projection.scaleY)})`,
    "translate(-50 -50)",
  ].join(" ");
}

function createProjection(rotation: FacehashData["rotation"], intensity3d: Intensity3D): FacehashProjection {
  const preset = PROJECTION_PRESETS[intensity3d];
  const baseProjection = {
    translateX: rotation.y * preset.translate,
    translateY: rotation.x * -preset.translate,
    scaleX: 1 - Math.abs(rotation.y) * preset.compress,
    scaleY: 1 - Math.abs(rotation.x) * preset.compress,
    skewX: rotation.x * -preset.skewX,
    skewY: rotation.y * preset.skewY,
  };

  return {
    ...baseProjection,
    cssTransform: buildCssTransform(baseProjection),
    svgTransform: buildSvgTransform(baseProjection),
  };
}

export function createFacehashScene(options: CreateFacehashSceneOptions): FacehashScene {
  const { name, colorsLength, intensity3d = "dramatic", pose = "seed" } = options;
  const data = computeFacehash({ name, colorsLength });
  const rotation = pose === "front" ? { x: 0, y: 0 } : data.rotation;
  const faceGeometry = FACE_GEOMETRIES[data.faceType];
  const aspectRatio = faceGeometry.viewBox.width / Math.max(faceGeometry.viewBox.height, 1);
  const faceHeight = FACE_WIDTH / aspectRatio;
  const projection = createProjection(rotation, intensity3d);
  const preset = PROJECTION_PRESETS[intensity3d];

  return {
    data,
    faceGeometry,
    projection,
    gradientCenter: {
      x: 50 - rotation.y * preset.gradientShift,
      y: 50 + rotation.x * preset.gradientShift,
    },
    faceBox: {
      x: 50 - FACE_WIDTH / 2,
      y: FACE_CENTER_Y - faceHeight / 2,
      width: FACE_WIDTH,
      height: faceHeight,
    },
    initialLayout: {
      x: 50,
      y: INITIAL_Y,
      fontSize: INITIAL_FONT_SIZE,
    },
    pose,
  };
}
