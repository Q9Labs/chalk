import { access } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, Image, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { loadRecordingWhiteboardFiles, parseRecordingWhiteboardStateV1, recordingWhiteboardSceneAppState } from "@q9labsai/chalk-react/headless";
import { expandFontFamilies, registerSubsetFamily } from "./fonts.js";
import type { Rect } from "./scene.js";

export interface WhiteboardAsset {
  readonly bytes: Buffer;
  readonly contentType: string;
}

export interface WhiteboardRendererOptions {
  /** Directory holding Excalidraw's font folders (Excalifont, Virgil, ...). */
  readonly fontsDirectory: string;
  readonly loadAsset: (assetId: string) => Promise<WhiteboardAsset>;
}

export type WhiteboardRenderer = (stateAssetId: string, colorScheme: "light" | "dark", rect: Rect) => Promise<Canvas>;

// Folder name → the CSS family Excalidraw asks for. Xiaolai (CJK) is left out: it is large and Latin text never needs it.
const EXCALIDRAW_FONTS: readonly (readonly [string, string])[] = [
  ["Excalifont", "Excalifont"],
  ["Virgil", "Virgil"],
  ["Cascadia", "Cascadia"],
  ["Nunito", "Nunito"],
  ["Lilita", "Lilita One"],
  ["ComicShanns", "Comic Shanns"],
  ["Liberation", "Liberation Sans"],
  ["Assistant", "Assistant"],
];

type Excalidraw = typeof import("@excalidraw/excalidraw");
type ChalkWhiteboard = typeof import("@q9labsai/chalk-whiteboard");

/**
 * Draws recorded whiteboard states with Excalidraw's own exportToCanvas, so
 * the Export keeps the hand-drawn look. Excalidraw expects a browser, so a
 * happy-dom window stands in and every canvas it creates is a Skia canvas.
 */
export function createWhiteboardRenderer(options: WhiteboardRendererOptions): WhiteboardRenderer {
  let modules: Promise<{ readonly excalidraw: Excalidraw; readonly whiteboard: ChalkWhiteboard }> | undefined;
  const rendered = new Map<string, Promise<Canvas>>();

  async function load(): Promise<{ readonly excalidraw: Excalidraw; readonly whiteboard: ChalkWhiteboard }> {
    await installDom();
    for (const [folder, family] of EXCALIDRAW_FONTS) {
      const directory = join(options.fontsDirectory, folder);
      if (await exists(directory)) await registerSubsetFamily(family, directory);
    }
    const [excalidraw, whiteboard] = await Promise.all([import("@excalidraw/excalidraw"), import("@q9labsai/chalk-whiteboard")]);
    return { excalidraw, whiteboard };
  }

  async function render(stateAssetId: string, colorScheme: "light" | "dark", rect: Rect): Promise<Canvas> {
    modules ??= load();
    const { excalidraw, whiteboard } = await modules;
    const state = parseRecordingWhiteboardStateV1(JSON.parse((await options.loadAsset(stateAssetId)).bytes.toString("utf8")));
    const files = await loadRecordingWhiteboardFiles(state, async ({ assetId }) => {
      const asset = await options.loadAsset(assetId);
      return { mimeType: asset.contentType, dataURL: `data:${asset.contentType};base64,${asset.bytes.toString("base64")}`, createdAtMs: 0 };
    });
    const elements = state.elements.map(whiteboard.fromWireElement).filter((element) => !element.isDeleted);
    const canvas = await excalidraw.exportToCanvas({
      elements,
      files,
      appState: { ...recordingWhiteboardSceneAppState(state, "#ffffff"), exportBackground: false, exportWithDarkMode: colorScheme === "dark" },
      exportPadding: 16,
      getDimensions: (width: number, height: number) => {
        const scale = Math.min(rect.width / Math.max(1, width), rect.height / Math.max(1, height));
        return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
      },
    });
    if (!isSkiaCanvas(canvas)) throw new TypeError("whiteboard export did not produce a Skia canvas");
    return canvas;
  }

  return async (stateAssetId, colorScheme, rect) => {
    const key = `${stateAssetId}:${colorScheme}:${rect.width}x${rect.height}`;
    let pending = rendered.get(key);
    if (pending === undefined) {
      pending = render(stateAssetId, colorScheme, rect);
      rendered.set(key, pending);
    }
    return await pending;
  };
}

function isSkiaCanvas(value: unknown): value is Canvas {
  return value instanceof Object && "encode" in value && "getContext" in value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

let domInstalled: Promise<void> | undefined;

function installDom(): Promise<void> {
  domInstalled ??= (async () => {
    const { Window } = await import("happy-dom");
    const window = new Window({ url: "http://localhost/" });
    const document = window.document;
    const createElement = document.createElement.bind(document);
    Object.defineProperty(document, "createElement", {
      configurable: true,
      value: (tagName: string, elementOptions?: ElementCreationOptions) => (tagName.toLowerCase() === "canvas" ? skiaCanvasElement() : createElement(tagName, elementOptions)),
    });
    Object.defineProperty(document, "fonts", { configurable: true, value: { add() {}, delete() {}, has: () => true, check: () => true, load: async () => [], ready: Promise.resolve(), forEach() {}, [Symbol.iterator]: function* () {} } });
    const globals: readonly (readonly [string, unknown])[] = Object.entries({
      window,
      document,
      navigator: window.navigator,
      location: window.location,
      HTMLElement: window.HTMLElement,
      Element: window.Element,
      Node: window.Node,
      DOMParser: window.DOMParser,
      XMLSerializer: window.XMLSerializer,
      SVGElement: window.SVGElement,
      getComputedStyle: window.getComputedStyle.bind(window),
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      matchMedia: window.matchMedia.bind(window),
      devicePixelRatio: 1,
      FontFace: StubFontFace,
      Image,
    });
    for (const [key, value] of globals) {
      if (key in globalThis && key !== "Image") continue;
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    Object.defineProperty(window, "FontFace", { configurable: true, value: StubFontFace });
    Object.defineProperty(window, "Image", { configurable: true, value: Image });
    Object.defineProperty(window, "EXCALIDRAW_ASSET_PATH", { configurable: true, value: "/" });
  })();
  return domInstalled;
}

class StubFontFace {
  readonly status = "loaded";
  constructor(
    readonly family: string,
    readonly source: unknown,
  ) {}
  async load(): Promise<this> {
    return this;
  }
}

/** A Skia canvas that answers the DOM calls Excalidraw makes on the canvases it creates. */
function skiaCanvasElement(): Canvas {
  const canvas = createCanvas(300, 150);
  const getContext = canvas.getContext.bind(canvas);
  let context: SKRSContext2D | undefined;
  Object.assign(canvas, {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {} },
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    getContext: (kind: "2d") => {
      if (context !== undefined) return context;
      const created = getContext(kind);
      const prototype = Object.getPrototypeOf(created) as object;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "font");
      if (descriptor?.set !== undefined && descriptor.get !== undefined) {
        const { get, set } = descriptor;
        Object.defineProperty(created, "font", { configurable: true, get: () => get.call(created), set: (value: string) => set.call(created, expandFontFamilies(value)) });
      }
      context = created;
      return created;
    },
  });
  return canvas;
}
