import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("a Sync restart does not stop the shared API tunnel connector", () => {
  const unit = readFileSync(new URL("../quadlet/chalk-cloudflared.container.in", import.meta.url), "utf8");
  assert.match(unit, /^Wants=chalk-api.service chalk-sync.service$/m);
  assert.doesNotMatch(unit, /^(Requires|BindsTo|PartOf)=.*chalk-(api|sync)\.service/m);
});
