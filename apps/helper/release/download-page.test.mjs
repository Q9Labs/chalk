import assert from "node:assert/strict";
import test from "node:test";
import { downloadPage } from "./download-page.mjs";

test("a production page with both downloads links the Mac installer and the Store listing", () => {
  const page = downloadPage({ channel: "production", version: "0.1.0", macDownload: "https://downloads.chalkmeet.com/helper/production/v0.1.0/1-1/Chalk-Helper.dmg", storeHref: "https://apps.microsoft.com/detail/x?a=1&b=2" });

  assert.match(page, /<title>Chalk Helper<\/title>/);
  assert.match(page, /href="https:\/\/downloads\.chalkmeet\.com\/helper\/production\/v0\.1\.0\/1-1\/Chalk-Helper\.dmg"/);
  assert.match(page, /Version 0\.1\.0 · macOS 14 or later/);
  assert.match(page, /href="https:\/\/apps\.microsoft\.com\/detail\/x\?a=1&amp;b=2"/);
  assert.doesNotMatch(page, /Nightly/);
});

test("a page with nothing published says so instead of linking", () => {
  const page = downloadPage({ channel: "production" });

  assert.match(page, /The Mac download isn’t available yet\./);
  assert.match(page, /Coming soon to the Microsoft Store\./);
  assert.doesNotMatch(page, /class="download primary"/);
});

test("the staging page is labelled Nightly and escapes a hostile version", () => {
  const page = downloadPage({ channel: "staging", version: '1"<b>', macDownload: "https://downloads.chalkmeet.com/helper/staging/x.dmg" });

  assert.match(page, /<title>Chalk Helper for Chalk Nightly<\/title>/);
  assert.match(page, /<span class="badge">Nightly<\/span>/);
  assert.match(page, /Version 1&quot;&lt;b>/);
});
