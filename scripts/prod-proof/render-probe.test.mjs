import assert from "node:assert/strict";
import test from "node:test";
import { renderEventMs } from "./render-probe.mjs";

test("the join is done when the last page has both a frame and audio", () => {
  const pages = [
    { video: 1_300, audio: 1_100 },
    { video: 1_250, audio: 1_900 },
  ];
  assert.equal(renderEventMs(pages, 1_000), 900);
});

test("a page that never reported a frame or audio gives no time", () => {
  assert.equal(
    renderEventMs(
      [
        { video: 1_300, audio: null },
        { video: 1_250, audio: 1_900 },
      ],
      1_000,
    ),
    null,
  );
  assert.equal(renderEventMs([{ video: 1_300, audio: 1_100 }, undefined], 1_000), null);
  assert.equal(renderEventMs([], 1_000), null);
});
