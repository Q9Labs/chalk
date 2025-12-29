// @ts-ignore
import { JSDOM } from "jsdom";
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
});
// @ts-ignore
globalThis.window = dom.window;
// @ts-ignore
globalThis.document = dom.window.document;
// @ts-ignore
globalThis.navigator = dom.window.navigator;
// @ts-ignore
globalThis.HTMLElement = dom.window.HTMLElement;
// @ts-ignore
globalThis.Node = dom.window.Node;
// @ts-ignore
globalThis.Event = dom.window.Event;
// @ts-ignore
globalThis.CustomEvent = dom.window.CustomEvent;
// @ts-ignore
globalThis.MouseEvent = dom.window.MouseEvent;
// @ts-ignore
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
// @ts-ignore
globalThis.FocusEvent = dom.window.FocusEvent;

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value.toString(); },
    clear: () => { store = {}; },
    removeItem: (key: string) => { delete store[key]; },
    length: Object.keys(store).length,
    key: (index: number) => Object.keys(store)[index] || null,
  };
})();
// @ts-ignore
globalThis.localStorage = localStorageMock;

// Mock requestAnimationFrame
// @ts-ignore
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
// @ts-ignore
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

Object.defineProperty(dom.window, 'matchMedia', {
  writable: true,
  value: (query: any) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

import { afterEach, expect } from "bun:test";
// @ts-ignore
import * as matchers from "@testing-library/jest-dom/matchers";
// @ts-ignore
import { cleanup } from "@testing-library/react";

// @ts-ignore
expect.extend(matchers);

afterEach(() => {
	cleanup();
});
