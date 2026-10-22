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

type SceneElement = ReturnType<WhiteboardEngineHandle["api"]["getSceneElementsIncludingDeleted"]>[number];
type SelectionStyle = Partial<Pick<SceneElement, "strokeColor" | "strokeWidth" | "backgroundColor">>;
type PenChanges = { readonly color?: PenColor; readonly width?: PenWidth };

function selectionStyle(element: SceneElement, pen: PenChoice, changes: PenChanges): SelectionStyle {
  if (element.type === "rectangle" && element.customData?.chalkNote) {
    if (!changes.color) return {};
    return { strokeColor: NOTE_FILL[changes.color], backgroundColor: NOTE_FILL[changes.color] };
  }
  const style = penStyle(element.type === "freedraw" && element.opacity === 40 ? "highlighter" : "pen", pen);
  return {
    ...(changes.color ? { strokeColor: style.strokeColor } : {}),
    ...(changes.width ? { strokeWidth: engineStrokeWidth(style.strokeWidth, element.type === "freedraw") } : {}),
  };
}

function styleChanged(element: SceneElement, updates: SelectionStyle): boolean {
  return (updates.strokeColor !== undefined && updates.strokeColor !== element.strokeColor) || (updates.strokeWidth !== undefined && updates.strokeWidth !== element.strokeWidth) || (updates.backgroundColor !== undefined && updates.backgroundColor !== element.backgroundColor);
}

/** A colour or width change applies to what is selected, as well as to the next stroke. */
export function restyleSelection(engine: WhiteboardEngineHandle, pen: PenChoice, changes: PenChanges): boolean {
  const { api, excalidraw } = engine;
  const selected = api.getAppState().selectedElementIds;
  let changed = false;
  const elements = api.getSceneElementsIncludingDeleted().map((element) => {
    if (!selected[element.id] || element.isDeleted) return element;
    const updates = selectionStyle(element, pen, changes);
    if (!styleChanged(element, updates)) return element;
    changed = true;
    return excalidraw.newElementWith(element, updates);
  });
  if (changed) api.updateScene({ elements, captureUpdate: excalidraw.CaptureUpdateAction.IMMEDIATELY });
  return changed;
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

export function sceneSignature(engine: WhiteboardEngineHandle): number {
  return engine.excalidraw.getSceneVersion(engine.api.getSceneElementsIncludingDeleted());
}
