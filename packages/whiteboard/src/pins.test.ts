import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { EXCALIDRAW_VERSION, MATHJAX_VERSION } from "./pins";

const dependencies = (path: string): Record<string, string> => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).dependencies;

it("pins the vendor versions the manifests install", () => {
  const whiteboard = dependencies("../package.json");
  expect(whiteboard["@excalidraw/excalidraw"]).toBe(EXCALIDRAW_VERSION);
  expect(whiteboard.mathjax).toBe(MATHJAX_VERSION);
  expect(dependencies("../../../apps/recording-renderer/package.json")["@excalidraw/excalidraw"]).toBe(EXCALIDRAW_VERSION);
});
