// @ts-ignore
import { JSDOM } from "jsdom";
import { afterEach, expect, vi } from "bun:test";
// @ts-ignore
import * as matchers from "@testing-library/jest-dom/matchers";
// @ts-ignore
import { cleanup } from "@testing-library/react";

// @ts-ignore
expect.extend(matchers);

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
globalThis.Element = dom.window.Element;
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
// @ts-ignore
globalThis.Audio = dom.window.Audio;
// @ts-ignore
globalThis.HTMLMediaElement = dom.window.HTMLMediaElement;

// Media element shims used across many components
// @ts-ignore
globalThis.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
// @ts-ignore
globalThis.HTMLMediaElement.prototype.pause = vi.fn();
// @ts-ignore
globalThis.HTMLElement.prototype.scrollIntoView = vi.fn();

// React DOM input event polyfills may call attachEvent/detachEvent in some environments.
// JSDOM doesn't implement these, so provide no-op shims to avoid noisy test errors.
// @ts-ignore
globalThis.HTMLElement.prototype.attachEvent ??= () => {};
// @ts-ignore
globalThis.HTMLElement.prototype.detachEvent ??= () => {};

// Some code may call `open(...)` (browser global alias for `window.open`).
// JSDOM's `window.open` may be missing or unimplemented; provide a stub.
// @ts-ignore
globalThis.open ??= dom.window.open?.bind(dom.window) ?? (() => null);

// Some libraries assume `getComputedStyle` is available as a global.
// @ts-ignore
globalThis.getComputedStyle ??= dom.window.getComputedStyle?.bind(dom.window);

// @testing-library/react tries to integrate with Jest fake timers when `jest` is present.
// Bun exposes a Jest-compatible global, but `jest.advanceTimersByTime()` throws unless fake timers are enabled.
// @testing-library/react calls this opportunistically during `waitFor`, so guard it.
const patchJestAdvanceTimers = (jestLike: any) => {
	if (!jestLike?.advanceTimersByTime || jestLike.__chalkPatchedAdvanceTimers) return;
	const originalAdvanceTimersByTime = jestLike.advanceTimersByTime.bind(jestLike);
	jestLike.advanceTimersByTime = (ms: number) => {
		try {
			return originalAdvanceTimersByTime(ms);
		} catch {
			// Ignore when fake timers aren't active.
		}
	};
	jestLike.__chalkPatchedAdvanceTimers = true;
};

// Patch current and also patch if the runtime assigns `globalThis.jest` later.
// @ts-ignore
patchJestAdvanceTimers(globalThis.jest);
try {
	// @ts-ignore
	let currentJest = globalThis.jest;
	// @ts-ignore
	Object.defineProperty(globalThis, 'jest', {
		configurable: true,
		get() {
			return currentJest;
		},
		set(next) {
			currentJest = next;
			patchJestAdvanceTimers(next);
		},
	});
} catch {
	// Best-effort only.
}

// Minimal clipboard mock for components that call navigator.clipboard.writeText()
// @ts-ignore
globalThis.navigator.clipboard ??= { writeText: async () => {} };

// Minimal mediaDevices mock for pre-join flows in tests
// @ts-ignore
globalThis.navigator.mediaDevices ??= {};
// @ts-ignore
globalThis.navigator.mediaDevices.enumerateDevices ??= async () => [];
// @ts-ignore
globalThis.navigator.mediaDevices.getUserMedia ??= async () => ({
	getTracks: () => [],
	getAudioTracks: () => [],
	getVideoTracks: () => [],
});
// @ts-ignore
globalThis.navigator.mediaDevices.addEventListener ??= () => {};
// @ts-ignore
globalThis.navigator.mediaDevices.removeEventListener ??= () => {};

// Observers used by @base-ui/react components
// @ts-ignore
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};
// @ts-ignore
globalThis.IntersectionObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

// AudioContext used by pre-join audio level metering
// @ts-ignore
globalThis.AudioContext ??= class {
	state: "running" | "suspended" | "closed" = "running";
	resume() {
		this.state = "running";
		return Promise.resolve();
	}
	createMediaStreamSource() {
		return { connect: () => {} };
	}
	createAnalyser() {
		return {
			fftSize: 256,
			smoothingTimeConstant: 0.5,
			frequencyBinCount: 128,
			getByteFrequencyData: () => {},
			connect: () => {},
		};
	}
	close() {
		this.state = "closed";
		return Promise.resolve();
	}
};

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

afterEach(() => {
	// Ensure fake timers never leak between test files.
	// This avoids @testing-library/react thinking Jest fake timers are enabled.
	try {
		vi.useRealTimers();
	} catch {
		// ignore
	}
	// @ts-ignore
	delete (setTimeout as any)._isMockFunction;
	// @ts-ignore
	delete (setTimeout as any).clock;

	cleanup();
});
