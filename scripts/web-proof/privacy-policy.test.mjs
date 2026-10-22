import assert from "node:assert/strict";
import { test } from "node:test";
import * as web from "../../apps/web/src/lib/privacy-policy.ts";
import * as mobile from "../../apps/mobile/src/privacy/privacy-policy.ts";

test("web and mobile announce the same Privacy Policy version", () => {
  assert.equal(mobile.MOBILE_PRIVACY_EFFECTIVE_DATE, web.PRIVACY_EFFECTIVE_DATE);
  assert.equal(mobile.MOBILE_PRIVACY_NOTICE_TEXT, web.PRIVACY_NOTICE_TEXT);
  assert.equal(mobile.MOBILE_PRIVACY_NOTICE_LINK_TEXT, web.PRIVACY_NOTICE_LINK_TEXT);
});

test("announces 6 November with at least 14 days after 23 October deployment", () => {
  assert.equal(web.PRIVACY_EFFECTIVE_DATE, "2026-11-06T00:00:00Z");
  assert.equal(mobile.MOBILE_PRIVACY_EFFECTIVE_DATE, "2026-11-06T00:00:00Z");
  assert.equal(web.PRIVACY_NOTICE_TEXT, "We're updating our Privacy Policy on 6 November 2026.");
  assert.equal(mobile.MOBILE_PRIVACY_NOTICE_TEXT, web.PRIVACY_NOTICE_TEXT);
  assert.equal(Date.parse(web.PRIVACY_EFFECTIVE_DATE) - Date.parse("2026-10-23T00:00:00Z"), 14 * 24 * 60 * 60 * 1000);
});
