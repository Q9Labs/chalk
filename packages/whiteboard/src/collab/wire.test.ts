// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from "vitest";
import { toWireElement } from "./wire";

let restoreElements: typeof import("@excalidraw/excalidraw").restoreElements;
beforeAll(async () => {
  window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false }));
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => ({ filter: "none", measureText: () => ({ width: 0 }) })) });
  restoreElements = (await import("@excalidraw/excalidraw")).restoreElements;
});

const limit = 16_384;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const round = (value: number) => Math.round(value * 100) / 100;
const stroke = (count: number, withPressure = false) => {
  const [element] = restoreElements(
    [
      {
        type: "freedraw",
        id: "long-stroke",
        index: "a0",
        x: 0,
        y: 0,
        width: 65,
        height: 200,
        points: Array.from({ length: count }, (_, index) => [(65 * index) / (count - 1), 100 * Math.sin((index / (count - 1)) * Math.PI * 5)]),
        pressures: withPressure ? Array.from({ length: count }, (_, index) => 0.123456 + index / count / 2) : [],
        simulatePressure: !withPressure,
        version: 7,
        versionNonce: 42,
      },
    ],
    null,
  );
  if (!element || element.type !== "freedraw") throw new Error("Missing freedraw fixture");
  return element;
};

it.each([600, 4000])("fits a %i-point stroke without changing the local element or its version", (count) => {
  const element = stroke(count, true);
  const original = JSON.stringify(element);
  expect(bytes(element)).toBeGreaterThan(limit);
  const wire = toWireElement(element);
  expect(bytes(wire.payload)).toBeLessThanOrEqual(limit);
  expect(bytes(wire)).toBeLessThanOrEqual(limit);
  expect(wire.version).toBe(7);
  expect(wire.version_nonce).toBe(42);
  expect(JSON.stringify(element)).toBe(original);
  const points = wire.payload.points;
  const pressures = wire.payload.pressures;
  if (!Array.isArray(points) || !Array.isArray(pressures)) throw new Error("Missing wire points or pressures");
  expect(points[0]).toEqual(element.points[0]?.map(round));
  expect(points.at(-1)).toEqual(element.points.at(-1)?.map(round));
  expect(pressures).toHaveLength(points.length);
  expect(pressures[0]).toBe(round(element.pressures[0] ?? 0));
  expect(pressures.at(-1)).toBe(round(element.pressures.at(-1) ?? 0));
  const rounded = element.points.map((point) => point.map(round));
  const roundedPressures = element.pressures.map(round);
  let smallestStride = 1;
  while (bytes({ ...wire, payload: { ...element, points: rounded.filter((_, index) => index % smallestStride === 0 || index === count - 1), pressures: roundedPressures.filter((_, index) => index % smallestStride === 0 || index === count - 1) } }) > limit) smallestStride++;
  expect(points).toEqual(rounded.filter((_, index) => index % smallestStride === 0 || index === count - 1));
});

it("only rounds when rounding alone fits", () => {
  const element = stroke(600);
  const wire = toWireElement(element);
  expect(bytes(element)).toBeGreaterThan(limit);
  expect(bytes(wire.payload)).toBeLessThanOrEqual(limit);
  expect(wire.payload.points).toEqual(element.points.map((point) => point.map(round)));
});

it("leaves an element under the payload limit byte-for-byte unchanged", () => {
  const element = stroke(24, true);
  expect(JSON.stringify(toWireElement(element).payload)).toBe(JSON.stringify(element));
});

it("refuses an oversized non-point payload", () => {
  const element = stroke(2);
  expect(() => toWireElement({ ...element, customData: { note: "界".repeat(limit) } })).toThrow(/payload/);
});

it("reserves the envelope bytes when rounding nearly fills the payload budget", () => {
  const element = stroke(600, true);
  const rounded = { ...element, points: element.points.map((point) => point.map(round)), pressures: element.pressures.map(round), customData: { note: "" } };
  const padded = { ...element, customData: { note: "x".repeat(limit - bytes(rounded) - 32) } };
  expect(bytes(toWireElement(padded))).toBeLessThanOrEqual(limit);
});

it("refuses an oversized elbowed arrow rather than invalidating its corners and segment indexes", () => {
  const points = Array.from({ length: 2000 }, (_, index) => [Math.ceil(index / 2) * 10, Math.floor(index / 2) * 10]);
  const [arrow] = restoreElements([{ type: "arrow", id: "elbow", index: "a0", x: 0, y: 0, width: 10000, height: 9990, elbowed: true, points, fixedSegments: [{ index: 1900, start: points[1899], end: points[1900] }] }], null);
  if (!arrow) throw new Error("Missing arrow fixture");
  const original = JSON.stringify(arrow);
  expect(() => toWireElement(arrow)).toThrow(/payload/);
  expect(JSON.stringify(arrow)).toBe(original);
});
