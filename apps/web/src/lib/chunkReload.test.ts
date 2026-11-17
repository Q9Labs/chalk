// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installChunkLoadAutoReload, onPageFailure, type PageFailure } from "./chunkReload";

installChunkLoadAutoReload();
const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

function causes(): PageFailure[] {
  const seen: PageFailure[] = [];
  stops.push(onPageFailure((cause) => seen.push(cause)));
  return seen;
}

it("reports an unhandled error that is not a chunk failure", () => {
  const seen = causes();
  window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
  expect(seen).toEqual(["unhandled_error"]);
});

it("reports an unhandled rejection", () => {
  const seen = causes();
  const event = new Event("unhandledrejection");
  Object.assign(event, { reason: new Error("nope") });
  window.dispatchEvent(event);
  expect(seen).toEqual(["unhandled_rejection"]);
});

it("stops telling a listener after it unsubscribes", () => {
  const seen: PageFailure[] = [];
  onPageFailure((cause) => seen.push(cause))();
  window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
  expect(seen).toEqual([]);
});
