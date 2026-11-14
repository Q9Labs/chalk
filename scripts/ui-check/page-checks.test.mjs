import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium } from "playwright";
import { MIN_TARGET, pageChecks } from "./page-checks.mjs";

let browser;
let page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 390, height: 600 } });
});
after(async () => {
  await browser?.close();
});

const checksFor = async (body) => {
  await page.setContent(`<!doctype html><style>*{box-sizing:border-box;margin:0}body{font:16px sans-serif}button{width:48px;height:48px}</style>${body}`);
  return (await page.evaluate(pageChecks, { minTarget: MIN_TARGET, perCheck: 25 })).map((finding) => finding.check);
};

test("a healthy screen has no findings", async () => {
  assert.deepEqual(await checksFor(`<main><p>Hello</p><button aria-label="Mute">m</button> <button aria-label="Leave">l</button></main>`), []);
});

test("an empty page is blank", async () => {
  assert.ok((await checksFor("")).includes("blank"));
});

test("an element wider than the screen is found", async () => {
  const found = await checksFor(`<div style="width:600px;height:40px;background:#ccc">wide</div>`);
  assert.ok(found.includes("viewport-overflow") || found.includes("page-scroll"));
});

test("a child cut off by its parent is found", async () => {
  const found = await checksFor(`<div style="width:100px;height:100px;overflow:hidden"><button aria-label="Cut" style="margin-left:70px">c</button></div>`);
  assert.ok(found.includes("child-clipped"));
});

test("text cut off by its box is found", async () => {
  const found = await checksFor(`<div style="width:60px;height:20px;overflow:hidden;white-space:nowrap">A very long participant name</div>`);
  assert.ok(found.includes("text-clipped"));
});

test("text that ends in an ellipsis on purpose is not clipped", async () => {
  const found = await checksFor(`<div style="width:60px;height:20px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A very long participant name</div>`);
  assert.ok(!found.includes("text-clipped"));
});

test("two controls on top of each other are found", async () => {
  const found = await checksFor(`<div style="position:relative"><button aria-label="A" style="position:absolute;left:0;top:0">a</button><button aria-label="B" style="position:absolute;left:20px;top:10px">b</button></div>`);
  assert.ok(found.includes("control-overlap"));
});

test("a control with a layer over its center is found", async () => {
  const found = await checksFor(`<button aria-label="Chat">c</button><div style="position:fixed;left:0;top:0;width:100px;height:100px;background:#0004"></div>`);
  assert.ok(found.includes("control-covered"));
});

test("a control smaller than the minimum target is found", async () => {
  const found = await checksFor(`<button aria-label="Tiny" style="width:12px;height:12px">t</button>`);
  assert.ok(found.includes("tap-target"));
});

test("a round avatar cut off by its tile is found", async () => {
  const found = await checksFor(`<div style="width:80px;height:80px;overflow:hidden"><div aria-hidden="true" style="width:150px;height:150px;border-radius:9999px;overflow:hidden;background:#aaa"></div></div>`);
  assert.ok(found.includes("child-clipped"));
});

test("a round avatar that fits its tile is not cut off", async () => {
  const found = await checksFor(`<div style="width:200px;height:200px;overflow:hidden"><div aria-hidden="true" style="width:150px;height:150px;border-radius:9999px;overflow:hidden;background:#aaa"></div></div>`);
  assert.ok(!found.includes("child-clipped"));
});

test("a face that stops short of its round frame is found, a centered icon is not", async () => {
  const circle = (child) => `<p>Nora</p><div aria-label="Avatar for Nora"><div aria-hidden="true" style="width:28px;height:28px;border-radius:9999px;overflow:hidden">${child}</div></div>`;
  assert.ok((await checksFor(circle(`<div style="width:24px;height:24px;background:#456"></div>`))).includes("frame-unfilled"));
  assert.deepEqual(await checksFor(circle(`<div style="width:28px;height:28px;background:#456"></div>`)), []);
  assert.deepEqual(await checksFor(circle(`<div style="width:20px;height:20px;margin:4px;background:#456"></div>`)), []);
});
