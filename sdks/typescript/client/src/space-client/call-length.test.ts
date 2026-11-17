import { expect, it } from "vitest";
import { callCountdown, callEndNotice, callLimitMessage, canExtendCall } from "./call-length";

const start = Date.parse("2026-11-17T10:00:00Z");

it("warns once per threshold and only for the latest one", () => {
  const deadline = "2026-11-17T11:00:00Z";
  expect(callCountdown(deadline, start).warning).toBeNull();
  expect(callCountdown(deadline, Date.parse("2026-11-17T10:50:00Z")).warning).toBe(10);
  expect(callCountdown(deadline, Date.parse("2026-11-17T10:50:01Z"), 600).warning).toBeNull();
  expect(callCountdown(deadline, Date.parse("2026-11-17T10:55:00Z"), 601).warning).toBe(5);
  expect(callCountdown(deadline, Date.parse("2026-11-17T10:59:30Z"), 360).warning).toBe(1);
  expect(callCountdown(deadline, Date.parse("2026-11-17T10:58:00Z")).warning).toBe(5);
  expect(callCountdown(null, start)).toEqual({ seconds: null, warning: null });
});

it("warns again after an extension moves the deadline out of the window", () => {
  const extended = "2026-11-17T11:30:00Z";
  expect(callCountdown(extended, Date.parse("2026-11-17T10:55:00Z"), 300).warning).toBeNull();
  expect(callCountdown(extended, Date.parse("2026-11-17T11:20:00Z"), 1800).warning).toBe(10);
});

it("names the limit and says why a call ended", () => {
  expect(callLimitMessage(1)).toBe("1 minute left.");
  expect(callLimitMessage(10)).toBe("10 minutes left.");
  expect(callEndNotice("maximum_duration").title).toBe("The call reached its time limit");
  expect(callEndNotice("ended_by_participant").detail).toBe("The host ended this call for everyone.");
  expect(callEndNotice(undefined)).toEqual({ title: "The call ended", detail: "" });
});

it("offers an extension only while the deadline is short of the Space maximum", () => {
  const episode = { startedAt: "2026-11-17T10:00:00Z", deadline: "2026-11-17T11:00:00Z" };
  expect(canExtendCall(episode, 3600)).toBe(false);
  expect(canExtendCall(episode, 86400)).toBe(true);
  expect(canExtendCall({ ...episode, deadline: "2026-11-18T10:00:00Z" }, 86400)).toBe(false);
  expect(canExtendCall(undefined, 86400)).toBe(false);
  expect(canExtendCall(episode, null)).toBe(false);
});
