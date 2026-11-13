import assert from "node:assert/strict";
import test from "node:test";
import { changesUi } from "./ui-paths.mjs";

test("a change to the web app, the UI package or the React SDK needs the check", () => {
  assert.equal(changesUi(["apps/web/src/components/space/SpacePage.tsx"]), true);
  assert.equal(changesUi(["packages/ui/src/styles/index.css"]), true);
  assert.equal(changesUi(["sdks/typescript/react/src/components/control-bar/ControlBar.tsx"]), true);
  assert.equal(changesUi(["scripts/ui-check/capture.mjs"]), true);
});

test("docs, tests and server code do not need it", () => {
  assert.equal(changesUi(["README.md", "docs/plans/architecture-rewrite.md"]), false);
  assert.equal(changesUi(["apps/web/src/call-states/stage.test.ts"]), false);
  assert.equal(changesUi(["apps/api/internal/spaces/service.go"]), false);
});

test("one UI file among others is enough", () => {
  assert.equal(changesUi(["apps/api/internal/spaces/service.go", "apps/web/src/styles/base.css"]), true);
});
