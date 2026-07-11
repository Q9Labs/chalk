import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, ExcalidrawImageElement, FileId, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export const CHALK_MATH_CUSTOM_DATA_KEY = "chalk";
export const CHALK_MATH_RENDERER = "mathjax-svg";

export interface ChalkMathCustomData {
  kind: "math";
  latex: string;
  renderer: typeof CHALK_MATH_RENDERER;
  version: 1;
  displayMode: boolean;
}

export interface MathImageAsset {
  file: BinaryFileData;
  width: number;
  height: number;
  customData: Record<string, unknown>;
}

const encodeBase64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);

  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
};

export const svgToDataUrl = (svg: string): DataURL => `data:image/svg+xml;base64,${encodeBase64(svg)}` as DataURL;

export const createMathFileId = () => `chalk-math-${Date.now()}-${Math.random().toString(36).slice(2)}` as FileId;

export function createMathImageAsset(args: { svg: string; width: number; height: number; latex: string; displayMode: boolean }): MathImageAsset {
  const created = Date.now();
  const fileId = createMathFileId();

  return {
    file: {
      id: fileId,
      mimeType: "image/svg+xml",
      dataURL: svgToDataUrl(args.svg),
      created,
      lastRetrieved: created,
    },
    width: args.width,
    height: args.height,
    customData: {
      [CHALK_MATH_CUSTOM_DATA_KEY]: {
        kind: "math",
        latex: args.latex,
        renderer: CHALK_MATH_RENDERER,
        version: 1,
        displayMode: args.displayMode,
      } satisfies ChalkMathCustomData,
    },
  };
}

export function getChalkMathData(element: ExcalidrawElement | null | undefined): ChalkMathCustomData | null {
  const data = element?.customData?.[CHALK_MATH_CUSTOM_DATA_KEY] as Partial<ChalkMathCustomData> | undefined;
  if (data?.kind !== "math" || typeof data.latex !== "string") return null;

  return {
    kind: "math",
    latex: data.latex,
    renderer: data.renderer === CHALK_MATH_RENDERER ? CHALK_MATH_RENDERER : CHALK_MATH_RENDERER,
    version: 1,
    displayMode: data.displayMode !== false,
  };
}

export function isChalkMathElement(element: ExcalidrawElement | null | undefined): element is ExcalidrawImageElement {
  return element?.type === "image" && getChalkMathData(element) !== null;
}

export function getSelectedMathElement(api: ExcalidrawImperativeAPI): ExcalidrawImageElement | null {
  const selectedIds = api.getAppState().selectedElementIds ?? {};
  const selected = api.getSceneElements().find((element) => selectedIds[element.id] && isChalkMathElement(element));
  return selected ? (selected as ExcalidrawImageElement) : null;
}

export function getInsertionPoint(api: ExcalidrawImperativeAPI, width: number, height: number): { x: number; y: number } {
  const appState = api.getAppState();
  const zoomValue = typeof appState.zoom === "object" && appState.zoom !== null && "value" in appState.zoom ? Number(appState.zoom.value) : 1;
  const zoom = Number.isFinite(zoomValue) && zoomValue > 0 ? zoomValue : 1;
  const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;

  return {
    x: Math.round((-appState.scrollX + viewportWidth / 2) / zoom - width / 2),
    y: Math.round((-appState.scrollY + viewportHeight / 2) / zoom - height / 2),
  };
}

export function appendOrReplaceMathElement(args: {
  api: ExcalidrawImperativeAPI;
  excalidraw: Pick<typeof import("@excalidraw/excalidraw"), "CaptureUpdateAction" | "convertToExcalidrawElements" | "newElementWith">;
  asset: MathImageAsset;
  existingElement?: ExcalidrawImageElement | null;
  status?: ExcalidrawImageElement["status"];
}): OrderedExcalidrawElement {
  const { api, asset, excalidraw, existingElement } = args;
  const status = args.status ?? "pending";

  api.addFiles([asset.file]);

  if (existingElement) {
    const nextElement = excalidraw.newElementWith(existingElement, {
      fileId: asset.file.id,
      width: asset.width,
      height: asset.height,
      status,
      customData: {
        ...(existingElement.customData ?? {}),
        ...asset.customData,
      },
    }) as OrderedExcalidrawElement;

    const nextElements = api.getSceneElementsIncludingDeleted().map((element) => (element.id === existingElement.id ? nextElement : element));
    api.updateScene({
      elements: nextElements,
      captureUpdate: excalidraw.CaptureUpdateAction.IMMEDIATELY,
    });
    return nextElement;
  }

  const point = getInsertionPoint(api, asset.width, asset.height);
  const [element] = excalidraw.convertToExcalidrawElements(
    [
      {
        type: "image",
        x: point.x,
        y: point.y,
        width: asset.width,
        height: asset.height,
        fileId: asset.file.id,
        status,
        customData: asset.customData,
      },
    ],
    { regenerateIds: true },
  );

  if (!element) throw new Error("Failed to create math element");

  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), element],
    appState: {
      selectedElementIds: { [element.id]: true },
    },
    captureUpdate: excalidraw.CaptureUpdateAction.IMMEDIATELY,
  });

  return element;
}
