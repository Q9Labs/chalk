import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deflate, inflate } from "./excalidraw-pako";

const scene = JSON.stringify({ type: "excalidraw", elements: [{ text: "∫ x² dx ✓ مرحبا" }] });
// pako 2.0.3 deflate(scene), the bytes Excalidraw embeds in a file exported before the swap.
const pakoDeflated = "eJyrViqpLEhVslJKrUhOzMlMKUosV9JRSs1JzU3NKylWsoquVipJrSgBKnjUsVqh4tAmhZQKhUdzJivcbL2x8cbaGytuLFeqja0FANBSHrg=";

describe("Excalidraw's pako replacement", () => {
  it("reads a scene that pako embedded", () => {
    expect(inflate(Buffer.from(pakoDeflated, "base64"), { to: "string" })).toBe(scene);
  });

  it("writes a zlib stream that any zlib reader opens", () => {
    expect(inflateSync(deflate(scene)).toString("utf8")).toBe(scene);
    expect(inflate(deflate(scene), { to: "string" })).toBe(scene);
  });

  it("keeps binary input and output as bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(inflate(deflate(bytes.buffer))).toEqual(bytes);
  });
});
