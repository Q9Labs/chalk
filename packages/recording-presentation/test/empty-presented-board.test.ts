import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseRecordingPresentationTimelineV1 } from "../src/validator.js";

test("the Go encoder's empty presented board timeline is renderable", async () => {
  const fixture = new URL("../../../apps/api/internal/recordingpresentation/testdata/empty-presented-board.json", import.meta.url);
  const timeline = parseRecordingPresentationTimelineV1(JSON.parse(await readFile(fixture, "utf8")));

  assert.equal(timeline.initial.sharedContent.kind, "whiteboard");
  assert.equal(timeline.events[0]?.kind, "shared_content_changed");
});
