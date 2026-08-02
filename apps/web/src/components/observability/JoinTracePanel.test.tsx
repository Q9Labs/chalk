// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ChalkSessionJoinTraceEvent } from "@q9labsai/chalk-client";
import { buildJoinTraceSpans, JoinTracePanel } from "./JoinTracePanel";

afterEach(cleanup);

const trace: ChalkSessionJoinTraceEvent[] = [
  { timestamp: 100, event: "join_span", state: "joining", epoch: 1, step: "join", spanId: "root", outcome: "started" },
  { timestamp: 102, event: "join_span", state: "joining", epoch: 1, step: "access_initialize", spanId: "access", parentSpanId: "root", outcome: "started" },
  { timestamp: 110, event: "join_span", state: "joining", epoch: 1, step: "access_initialize", spanId: "access", parentSpanId: "root", outcome: "succeeded", durationMs: 8 },
  { timestamp: 112, event: "join_span", state: "joining", epoch: 1, step: "start_media", spanId: "media", parentSpanId: "root", outcome: "started" },
  { timestamp: 124, event: "join_span", state: "joining", epoch: 1, step: "start_media", spanId: "media", parentSpanId: "root", outcome: "succeeded", durationMs: 12 },
  { timestamp: 142, event: "join_span", state: "live", epoch: 1, step: "join", spanId: "root", outcome: "succeeded", durationMs: 42 },
];

describe("JoinTracePanel", () => {
  it("pairs Chalk span lifecycle events into selectable views", () => {
    expect(buildJoinTraceSpans(trace)).toEqual([
      expect.objectContaining({ spanId: "root", step: "join", durationMs: 42, outcome: "succeeded" }),
      expect.objectContaining({ spanId: "access", step: "access_initialize", durationMs: 8, outcome: "succeeded" }),
      expect.objectContaining({ spanId: "media", step: "start_media", durationMs: 12, outcome: "succeeded" }),
    ]);

    render(<JoinTracePanel events={trace} />);

    expect(screen.getByRole("heading", { name: "Chalk join path" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Join status: live" })).toBeTruthy();
    expect(screen.getByText("Initialize access")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("tree", { name: "Join trace span graph" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Start media/ }));
    expect(screen.getByText("Selected span")).toBeTruthy();
    expect(screen.getByText("12 ms")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Flame" }));
    expect(screen.getByRole("list", { name: "Join trace flame view" })).toBeTruthy();
  });

  it("shows a useful empty state before the first join", () => {
    render(<JoinTracePanel events={[]} />);

    expect(screen.getByText("Awaiting a Chalk join")).toBeTruthy();
    expect(screen.getByText("Waiting for a Chalk session")).toBeTruthy();
  });
});
