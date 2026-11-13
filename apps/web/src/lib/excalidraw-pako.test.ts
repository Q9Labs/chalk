import { deflateSync, inflateSync } from "node:zlib";
import { strFromU8, unzlibSync } from "fflate";
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

  it("checks the trailer of long streams the way zlib writes it", () => {
    const long = new Uint8Array(200_000).map((_, index) => (index * 7919) % 256);
    expect(inflate(deflateSync(long))).toEqual(long);
  });

  it("rejects a scene whose bytes changed after it was embedded, as pako does", () => {
    const original = Buffer.from(pakoDeflated, "base64");
    const altered = [...original.keys()].slice(2, -4).flatMap((position) => {
      const corrupted = Uint8Array.from(original);
      corrupted[position] = (original.at(position) ?? 0) ^ 2;
      try {
        return strFromU8(unzlibSync(corrupted)) === scene ? [] : [corrupted];
      } catch {
        return [];
      }
    });
    expect(altered.length).toBeGreaterThan(0);
    for (const corrupted of altered) expect(() => inflate(corrupted, { to: "string" })).toThrow("incorrect data check");
  });

  it("keeps binary input and output as bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(inflate(deflate(bytes.buffer))).toEqual(bytes);
  });
});
