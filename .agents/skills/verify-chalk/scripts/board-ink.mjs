// The scene can hold a stroke while the canvas stays blank or mis-sized, so also read the painted pixels.
function readCanvas() {
  const board = document.querySelector(".chalk-board");
  const canvas = board?.querySelector("canvas");
  const context = canvas instanceof HTMLCanvasElement ? canvas.getContext("2d") : null;
  if (!board || !(canvas instanceof HTMLCanvasElement) || !context) return null;
  const box = board.getBoundingClientRect();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 32) ink += 1;
  return { ink, sizeError: Math.max(Math.abs(canvas.width / devicePixelRatio - box.width), Math.abs(canvas.height / devicePixelRatio - box.height)) };
}

/** Waits until the painted canvas satisfies `accept(ink)` and fills the board; returns the ink count. */
export async function paintedInk(page, accept) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(readCanvas);
    if (last && last.sizeError <= 2 && accept(last.ink)) return last.ink;
    await page.waitForTimeout(250);
  }
  throw new Error(`The board canvas did not paint as expected (last read: ${JSON.stringify(last)})`);
}
