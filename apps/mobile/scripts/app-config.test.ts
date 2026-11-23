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
