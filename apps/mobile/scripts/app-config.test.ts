import assert from "node:assert/strict";
import test from "node:test";

test("the nightly build uses the production API and production invite hosts", async () => {
  process.env.CHALK_APP_VARIANT = "nightly";
  delete process.env.EAS_BUILD_PROFILE;
  const {
    default: { expo },
  } = await import("../app.config");

  assert.equal(expo.extra.buildProfile, "nightly");
  assert.equal(expo.extra.apiBaseURL, "https://api.chalkmeet.com");
  assert.deepEqual(expo.ios.associatedDomains, ["applinks:chalkmeet.com", "applinks:chalk.q9labs.ai"]);
  assert.deepEqual(
    expo.android.intentFilters.map(({ data }) => data.map(({ host }) => host)),
    [
      ["chalkmeet.com", "chalk.q9labs.ai"],
      ["chalkmeet.com", "chalk.q9labs.ai"],
    ],
  );
});

test("the iOS app gives the screen capturer its broadcast extension and app group", async () => {
  const { readFile } = await import("node:fs/promises");
  const {
    default: { expo },
  } = await import("../app.config");
  const manifest = JSON.parse(await readFile(new URL("../../../release/manifest.json", import.meta.url), "utf8"));
  const plist = await readFile(new URL("../ios/Chalk/Info.plist", import.meta.url), "utf8");
  const extensionEntitlements = await readFile(new URL("../ios/ChalkScreenShare/ChalkScreenShare.entitlements", import.meta.url), "utf8");
  const plistValue = (key: string) => new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1];

  // @cloudflare/react-native-webrtc reads exactly these keys. Without them the broadcast picker lists every app and the capturer never opens its socket.
  const { RTCAppGroupIdentifier: group, RTCScreenSharingExtension: extension } = expo.ios.infoPlist;
  assert.equal(extension, manifest.apple.screen_share_bundle_id);
  assert.ok(expo.ios.entitlements["com.apple.security.application-groups"].includes(group));
  assert.ok(extensionEntitlements.includes(`<string>${group}</string>`));
  assert.equal(plistValue("RTCAppGroupIdentifier"), group);
  assert.equal(plistValue("RTCScreenSharingExtension"), extension);
});
