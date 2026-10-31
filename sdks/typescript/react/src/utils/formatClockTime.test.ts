import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { formatClockTime } from "./formatClockTime";

it.each([
  [0, 0, "12:00 AM"],
  [0, 5, "12:05 AM"],
  [12, 0, "12:00 PM"],
  [3, 5, "3:05 AM"],
  [15, 5, "3:05 PM"],
  [23, 59, "11:59 PM"],
] as const)("formats %i:%i as %s", (hour, minute, expected) => {
  expect(formatClockTime(new Date(2026, 9, 26, hour, minute).toISOString())).toBe(expected);
});

it("uses AM/PM with a non-US default locale", () => {
  const script = `import { formatClockTime } from ${JSON.stringify(new URL("./formatClockTime.ts", import.meta.url).href)};
    console.log(Intl.DateTimeFormat().resolvedOptions().locale);
    console.log(formatClockTime("2026-10-26T15:05:00Z"));`;
  const output = execFileSync(process.execPath, ["--import=tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", TZ: "UTC" },
    encoding: "utf8",
  });
  expect(output.trim().split("\n")).toEqual(["de-DE", "3:05 PM"]);
});
