import assert from "node:assert/strict";
import { test } from "node:test";
import * as web from "../../apps/web/src/lib/privacy-policy.ts";
import * as mobile from "../../apps/mobile/src/privacy/privacy-policy.ts";

test("web and mobile announce the same Privacy Policy version", () => {
  assert.equal(mobile.MOBILE_PRIVACY_EFFECTIVE_DATE, web.PRIVACY_EFFECTIVE_DATE);
  assert.equal(mobile.MOBILE_PRIVACY_NOTICE_TEXT, web.PRIVACY_NOTICE_TEXT);
  assert.equal(mobile.MOBILE_PRIVACY_NOTICE_LINK_TEXT, web.PRIVACY_NOTICE_LINK_TEXT);
});
