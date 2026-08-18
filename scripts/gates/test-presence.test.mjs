import assert from "node:assert/strict";
import test from "node:test";

import { candidateTestsFor } from "./test-presence.mjs";

test("accepts a colocated directory suite for cohesive source modules", () => {
  const candidates = candidateTestsFor("sdks/typescript/react/src/components/chalk-ui/ChalkAlert.tsx");

  assert.ok(candidates.includes("sdks/typescript/react/src/components/chalk-ui/chalk-ui.test.tsx"));
});
