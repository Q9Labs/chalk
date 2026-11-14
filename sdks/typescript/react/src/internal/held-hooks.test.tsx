// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useHeldWhile } from "./useHeldWhile";
import { useRecordingSeconds } from "./useRecordingSeconds";
import { useSeenConnected } from "./useSeenConnected";

afterEach(() => document.body.replaceChildren());

function probe<Props, Result>(hook: (props: Props) => Result, first: Props) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seen: Result[] = [];
  const Probe = (props: Props) => {
    seen.push(hook(props));
    return null;
  };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Probe {...(first as object & Props)} />));
  return { latest: () => seen[seen.length - 1] as Result, update: (props: Props) => act(() => root.render(<Probe {...(props as object & Props)} />)) };
}

it("keeps showing the last value from before the hold and follows the value again after it", () => {
  const view = probe(({ value, hold }: { value: string; hold: boolean }) => useHeldWhile(value, hold), { value: "two people", hold: false });
  view.update({ value: "nobody", hold: true });
  expect(view.latest()).toBe("two people");
  view.update({ value: "three people", hold: false });
  expect(view.latest()).toBe("three people");
});

it("remembers who was connected, so a seat that never connected is not a reconnecting one", () => {
  const seat = (participantId: string, state: string) => ({ participantId, presence: { state } });
  const view = probe(({ roster }: { roster: ReturnType<typeof seat>[] }) => useSeenConnected(roster), { roster: [seat("nora", "connected"), seat("kai", "disconnected")] });
  view.update({ roster: [seat("nora", "disconnected"), seat("kai", "disconnected")] });
  expect(view.latest().has("nora")).toBe(true);
  expect(view.latest().has("kai")).toBe(false);
});

it("counts recording time from the moment it was seen to start, and knows none for someone who joined mid-recording", () => {
  type Props = { status: Parameters<typeof useRecordingSeconds>[0]; episode: number };
  const joinedLate = probe(({ status, episode }: Props) => useRecordingSeconds(status, episode), { status: "recording", episode: 300 });
  expect(joinedLate.latest()).toBeNull();

  const host = probe(({ status, episode }: Props) => useRecordingSeconds(status, episode), { status: undefined, episode: 100 });
  host.update({ status: "starting", episode: 101 });
  host.update({ status: "recording", episode: 102 });
  host.update({ status: "recording", episode: 167 });
  expect(host.latest()).toBe(65);
  host.update({ status: "stopping", episode: 170 });
  expect(host.latest()).toBe(68);
  host.update({ status: "stopped", episode: 171 });
  expect(host.latest()).toBeNull();
});
