// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { ELEMENT_ENCODED_BYTES_LIMIT, toFittedWireElement, toWireElement } from "./wire";

let restoreElements: typeof import("@excalidraw/excalidraw").restoreElements;
beforeAll(async () => {
  window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false }));
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => ({ filter: "none", measureText: () => ({ width: 0 }) })) });
  restoreElements = (await import("@excalidraw/excalidraw")).restoreElements;
});

const limit = ELEMENT_ENCODED_BYTES_LIMIT;
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

it("keeps the engine's element size at the whiteboard-v1 limit less the margin for the server's encoder", () => {
  const contract = readFileSync(resolve(__dirname, "../../../../contract/schema/whiteboard-v1.json"), "utf8");
  const contractLimit = Number(/"elementPayloadEncodedBytes":\s*(\d+)/.exec(contract)?.[1]);
  expect(limit).toBe(contractLimit - 64);
});

it.each([600, 4000])("fits a %i-point stroke without changing the local element or its version", (count) => {
  const element = stroke(count, true);
  const original = JSON.stringify(element);
  expect(bytes(element)).toBeGreaterThan(limit);
  const wire = toFittedWireElement(element);
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
  const wire = toFittedWireElement(element);
  expect(bytes(toWireElement(element))).toBeGreaterThan(limit);
  expect(bytes(wire)).toBeLessThanOrEqual(limit);
  expect(wire.payload.points).toEqual(element.points.map((point) => point.map(round)));
});

it("counts the two bytes that the server adds to a number such as 1e-7", () => {
  const element = { ...stroke(2), points: Array.from({ length: 1300 }, () => [1e-7, 2e-7] as [number, number]) };
  expect(bytes(toWireElement(element))).toBeLessThanOrEqual(limit);
  const wire = toFittedWireElement(element);
  // On the server this element is 5,200 bytes larger, so it must not go out as it is.
  expect(wire.payload.points).toEqual(element.points.map(() => [0, 0]));
});

it("submits an element under the limit exactly as the public conversion gives it", () => {
  const element = stroke(24, true);
  expect(toFittedWireElement(element)).toEqual(toWireElement(element));
});

it("keeps the public conversion lossless for a stroke over the limit", () => {
  const element = stroke(4000, true);
  const wire = toWireElement(element);
  expect(bytes(wire)).toBeGreaterThan(limit);
  expect(wire.payload.points).toEqual(element.points);
  expect(wire.payload.pressures).toEqual(element.pressures);
});

it("refuses an oversized element that has no points", () => {
  const [shape] = restoreElements([{ type: "rectangle", id: "large", index: "a0", x: 0, y: 0, width: 10, height: 10, customData: { note: "界".repeat(limit) }, version: 3, versionNonce: 9 }], null);
  if (!shape) throw new Error("Missing rectangle fixture");
  expect("points" in shape).toBe(false);
  expect(() => toFittedWireElement(shape)).toThrow(/exceeds/);
});

it("refuses a stroke whose other fields alone exceed the limit", () => {
  expect(() => toFittedWireElement({ ...stroke(2), customData: { note: "界".repeat(limit) } })).toThrow(/exceeds/);
});

it("counts the envelope when rounding nearly fills the budget", () => {
  const element = stroke(600, true);
  const rounded = { ...element, points: element.points.map((point) => point.map(round)), pressures: element.pressures.map(round), customData: { note: "" } };
  const padded = { ...element, customData: { note: "x".repeat(limit - bytes(rounded) - 32) } };
  expect(bytes(toFittedWireElement(padded))).toBeLessThanOrEqual(limit);
});

it("refuses an oversized elbowed arrow rather than invalidating its corners and segment indexes", () => {
  const points = Array.from({ length: 2000 }, (_, index) => [Math.ceil(index / 2) * 10, Math.floor(index / 2) * 10]);
  const [arrow] = restoreElements([{ type: "arrow", id: "elbow", index: "a0", x: 0, y: 0, width: 10000, height: 9990, elbowed: true, points, fixedSegments: [{ index: 1900, start: points[1899], end: points[1900] }] }], null);
  if (!arrow) throw new Error("Missing arrow fixture");
  const original = JSON.stringify(arrow);
  expect(() => toFittedWireElement(arrow)).toThrow(/exceeds/);
  expect(JSON.stringify(arrow)).toBe(original);
});
