import { describe, expect, it } from "vitest";
import { readBodyWithinLimit } from "./request-safety";

describe("bounded request streams", () => {
  it("preserves an exact-limit body split across chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    const init = { method: "POST", body, duplex: "half" };
    const result = await readBodyWithinLimit(new Request("https://chalk.test", init), 4);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4]).buffer);
  });

  it("accepts an empty body", async () => {
    expect(await readBodyWithinLimit(new Request("https://chalk.test"), 4)).toEqual(new ArrayBuffer(0));
  });

  it("propagates a stream failure", async () => {
    const failure = new Error("stream failed");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const init = { method: "POST", body, duplex: "half" };
    await expect(readBodyWithinLimit(new Request("https://chalk.test", init), 4)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });
});
