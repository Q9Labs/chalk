import assert from "node:assert/strict";
import { test } from "node:test";
import { hasConflictingTurnKey } from "../cloudflare-turn/provider.ts";

test("TURN creation refuses an existing name but allows updates of its saved key", () => {
  const keys = [
    { name: "chalk-nightly-turn", uid: "existing" },
    { name: "other", uid: "other" },
  ];
  assert.equal(hasConflictingTurnKey(keys, "chalk-nightly-turn", undefined), true);
  assert.equal(hasConflictingTurnKey(keys, "chalk-nightly-turn", "existing"), false);
  assert.equal(hasConflictingTurnKey(keys, "chalk-nightly-turn", "stale"), true);
  assert.equal(hasConflictingTurnKey(keys, "chalk-production-turn", undefined), false);
  assert.equal(hasConflictingTurnKey([...keys, { name: "chalk-nightly-turn", uid: "duplicate" }], "chalk-nightly-turn", "existing"), true);
});
