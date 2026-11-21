/* @vitest-environment jsdom */
/// <reference types="vitest/jsdom" />

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MeasuredTalk } from "../../lib/dashboard/talk-time";
import { TalkTime } from "./TalkTime";

let view: ReturnType<typeof createRoot> | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => view?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(talk: MeasuredTalk) {
  const host = document.body.appendChild(document.createElement("div"));
  view = createRoot(host);
  await act(async () => view?.render(<TalkTime talk={talk} playback={null} />));
  return host;
}

const silentSession: MeasuredTalk = {
  kind: "available",
  durationMs: 600_000,
  totalTalkMs: 0,
  overlapMs: 0,
  silenceMs: 600_000,
  bucketMs: 10_000,
  recordings: [{ id: "recording", offsetMs: 0, transcribed: true }],
  speakers: [{ key: "ada", name: "Ada", talkMs: 0, share: 0, turns: 0, buckets: [] }],
};

it("shows the silence total when a complete transcript has no speech", async () => {
  const text = (await render(silentSession)).textContent ?? "";
  expect(text).toContain("Silent");
  expect(text).toContain("10 min");
  expect(text).not.toContain("this session has none");
});
