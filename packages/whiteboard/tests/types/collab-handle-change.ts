import type { ExcalidrawCollabEngine } from "../../src/collab/engine";
import type { AppState, BinaryFiles, OrderedExcalidrawElement } from "../../src/collab/types";

// `/collab` is a published entry: callers written against `handleChange(elements, appState, files)` must keep compiling.
declare const engine: ExcalidrawCollabEngine;
declare const elements: readonly OrderedExcalidrawElement[];
declare const appState: AppState;
declare const files: BinaryFiles;

engine.handleChange(elements, appState, files);
engine.handleChange();
