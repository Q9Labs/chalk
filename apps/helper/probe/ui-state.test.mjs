import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_STATES } from "./ui-fixtures.mjs";
import { displayShape, groupedCode, settingsState, spokenCode } from "../ui/state.js";

test("every Settings fixture lands on its own card", () => {
  const expected = { waiting: "waiting", pair: "pair", confirm: "confirm", display: "display", permission: "permission", "permission-waiting": "permission", live: "live", "live-later": "live", device: "waiting" };
  for (const [name, view] of Object.entries(SETTINGS_STATES)) assert.equal(settingsState(view), expected[name], name);
});

test("a session that Sync has not accepted yet is still waiting", () => {
  assert.equal(settingsState({ ...SETTINGS_STATES.live, connected: false }), "waiting");
});

test("a single display skips the picker", () => {
  assert.equal(settingsState({ ...SETTINGS_STATES.display, monitors: [SETTINGS_STATES.display.monitors[0]] }), "connected");
});

test("the confirmation code is grouped for sight and spoken one character at a time", () => {
  assert.equal(groupedCode("K7QM2X9FHT4CWP6N"), "K7QM-2X9F-HT4C-WP6N");
  assert.equal(groupedCode("K7QM-2X9F-HT4C-WP6N"), "K7QM-2X9F-HT4C-WP6N");
  assert.equal(spokenCode("4F2A-91C0"), "4 F 2 A 9 1 C 0");
});

test("display tiles keep the screen's shape", () => {
  assert.deepEqual(displayShape({ width: 200, height: 100 }), { width: 100, height: 50 });
  assert.deepEqual(displayShape({ width: 100, height: 200 }), { width: 50, height: 100 });
});
