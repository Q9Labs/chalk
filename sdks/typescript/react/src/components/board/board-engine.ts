import type { WhiteboardEngineHandle } from "@q9labsai/chalk-whiteboard/react";
import { NOTE_FILL, NOTE_ROUNDNESS, NOTE_SIZE, NOTE_TEXT, engineStrokeWidth, highlighterStyle, penHex, widthUnits, type BoardSurface, type BoardTool, type CallTheme, type Camera, type PenColor, type PenWidth } from "./board-model";

/** The pen the person has chosen, and the surface it is drawn on. */
export type PenChoice = { readonly color: PenColor; readonly width: PenWidth; readonly surface: BoardSurface; readonly theme: CallTheme };

// Nunito is the engine's clean sans; the call's own Figtree is not one of its fonts.
const TEXT_FONT = 6;
const NOTE_FONT_SIZE = 18;
// Excalidraw's BOUND_TEXT_PADDING, which it does not export.
const BOUND_TEXT_PADDING = 5;

type EngineTool = Parameters<WhiteboardEngineHandle["api"]["setActiveTool"]>[0];

function engineTool(tool: BoardTool): EngineTool {
  // A drawing tool stays chosen after each shape, as the island shows; the engine would otherwise drop back to selection.
  if (tool === "pen" || tool === "highlighter") return { type: "freedraw", locked: true };
  // The sticky note is placed by the board itself, so the engine just selects meanwhile.
  if (tool === "note" || tool === "selection") return { type: "selection" };
  return { type: tool, locked: true };
}

function penStyle(tool: BoardTool, pen: PenChoice) {
  if (tool === "highlighter") return highlighterStyle(pen.color, pen.width);
  return { strokeColor: penHex(pen.color, pen.surface, pen.theme), strokeWidth: widthUnits(pen.width), opacity: 100 };
}

export function applyTool(engine: WhiteboardEngineHandle, tool: BoardTool, pen: PenChoice): void {
  const style = penStyle(tool, pen);
  engine.api.updateScene({
    appState: {
      currentItemStrokeColor: style.strokeColor,
      currentItemStrokeWidth: engineStrokeWidth(style.strokeWidth, tool === "pen" || tool === "highlighter"),
      currentItemOpacity: style.opacity,
      currentItemRoughness: 0,
      currentItemFontFamily: TEXT_FONT,
      currentItemBackgroundColor: "transparent",
    },
  });
  engine.api.setActiveTool(engineTool(tool));
}

/** A colour or width change applies to what is selected, as well as to the next stroke. */
export function restyleSelection(engine: WhiteboardEngineHandle, tool: BoardTool, pen: PenChoice): void {
  const { api, excalidraw } = engine;
  const selected = api.getAppState().selectedElementIds;
  if (Object.keys(selected).length === 0) return;
  const style = penStyle(tool === "highlighter" ? "highlighter" : "pen", pen);
  const elements = api.getSceneElementsIncludingDeleted().map((element) => {
    if (!selected[element.id] || element.isDeleted) return element;
    if (element.type === "rectangle" && element.customData?.chalkNote) return excalidraw.newElementWith(element, { backgroundColor: NOTE_FILL[pen.color], strokeColor: NOTE_FILL[pen.color] });
    return excalidraw.newElementWith(element, { strokeColor: style.strokeColor, strokeWidth: engineStrokeWidth(style.strokeWidth, element.type === "freedraw") });
  });
  api.updateScene({ elements, captureUpdate: excalidraw.CaptureUpdateAction.IMMEDIATELY });
}

/** Places a plain sticky note centred on the board point and opens its text at once. */
export function placeNote(engine: WhiteboardEngineHandle, container: HTMLElement, point: { readonly x: number; readonly y: number }, color: PenColor): void {
  const { api, excalidraw } = engine;
  const fill = NOTE_FILL[color];
  const [note] = excalidraw.convertToExcalidrawElements([
    { type: "rectangle", x: point.x - NOTE_SIZE.width / 2, y: point.y - NOTE_SIZE.height / 2, width: NOTE_SIZE.width, height: NOTE_SIZE.height, backgroundColor: fill, strokeColor: fill, fillStyle: "solid", strokeWidth: 1, roughness: 0, roundness: NOTE_ROUNDNESS, customData: { chalkNote: true } },
  ]);
  if (!note) return;
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), note],
    appState: { selectedElementIds: { [note.id]: true }, currentItemStrokeColor: NOTE_TEXT, currentItemFontSize: NOTE_FONT_SIZE, currentItemTextAlign: "left", currentItemFontFamily: TEXT_FONT },
    captureUpdate: excalidraw.CaptureUpdateAction.IMMEDIATELY,
  });
  api.setActiveTool({ type: "selection" });
  // The engine opens a container's text on Enter; it has no call for it.
  requestAnimationFrame(() => container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })));
}

/** Text written in a note sits at its top left, like the mockup's notes. */
export function settleNoteText(engine: WhiteboardEngineHandle): void {
  const { api, excalidraw } = engine;
  const elements = api.getSceneElementsIncludingDeleted();
  const notes = new Map(elements.filter((element) => element.type === "rectangle" && element.customData?.chalkNote).map((element) => [element.id, element]));
  let changed = false;
  const next = elements.map((element) => {
    if (element.type !== "text" || !element.containerId || element.isDeleted) return element;
    const note = notes.get(element.containerId);
    if (!note) return element;
    // updateScene does not lay bound text out again, so place it where the engine's top-left layout would.
    const x = note.x + BOUND_TEXT_PADDING;
    const y = note.y + BOUND_TEXT_PADDING;
    if (element.verticalAlign === "top" && element.textAlign === "left" && element.strokeColor === NOTE_TEXT && element.x === x && element.y === y) return element;
    changed = true;
    return excalidraw.newElementWith(element, { verticalAlign: "top", textAlign: "left", strokeColor: NOTE_TEXT, x, y });
  });
  if (changed) api.updateScene({ elements: next, captureUpdate: excalidraw.CaptureUpdateAction.NEVER });
}

const isApple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Undo and redo have no engine call, so the board presses the engine's own keys. */
export function pressHistory(container: HTMLElement, redo: boolean): void {
  const apple = isApple();
  container.dispatchEvent(new KeyboardEvent("keydown", { key: redo ? "Z" : "z", code: "KeyZ", shiftKey: redo, metaKey: apple, ctrlKey: !apple, bubbles: true }));
}

export function readCamera(engine: WhiteboardEngineHandle): Camera {
  const state = engine.api.getAppState();
  return { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value };
}

export function setCamera(engine: WhiteboardEngineHandle, camera: Camera): void {
  // The engine brands zoom values; this one is already clamped to its range.
  engine.api.updateScene({ appState: { scrollX: camera.scrollX, scrollY: camera.scrollY, zoom: { value: camera.zoom as never } } });
}

export function hasContent(engine: WhiteboardEngineHandle): boolean {
  return engine.api.getSceneElements().length > 0;
}

export async function boardImage(engine: WhiteboardEngineHandle, background: string): Promise<Blob> {
  const { api, excalidraw } = engine;
  return excalidraw.exportToBlob({ elements: api.getSceneElements(), files: api.getFiles(), appState: { exportBackground: true, viewBackgroundColor: background }, mimeType: "image/png", exportPadding: 24 });
}

/** Clears the board and returns the way back, while nothing else has changed. */
export async function clearWithUndo(engine: WhiteboardEngineHandle): Promise<() => boolean> {
  const before = engine.api.getSceneElements();
  await engine.clear();
  return () => {
    if (engine.api.getSceneElements().length > 0) return false;
    const { excalidraw } = engine;
    engine.api.updateScene({ elements: before.map((element) => excalidraw.newElementWith(element, {})), captureUpdate: excalidraw.CaptureUpdateAction.IMMEDIATELY });
    return true;
  };
}

export function sceneSignature(engine: WhiteboardEngineHandle): number {
  return engine.excalidraw.getSceneVersion(engine.api.getSceneElementsIncludingDeleted());
}
