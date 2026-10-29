import { afterEach, expect, it, vi } from "vitest";
import { installChunkLoadAutoReload } from "./chunkReload";

afterEach(() => vi.unstubAllGlobals());

it("reloads once for rejection messages and browser error events", () => {
  const target = new EventTarget();
  const replace = vi.fn();
  const guard = new Map<string, string>();
  vi.stubGlobal("window", Object.assign(target, { location: { href: "https://example.test/space", replace } }));
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => guard.get(key), setItem: (key: string, value: string) => guard.set(key, value) });
  installChunkLoadAutoReload();

  for (const reason of [undefined, null, 42, {}, { message: 42 }, new Error("unrelated failure")]) {
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
  }
  expect(replace).not.toHaveBeenCalled();

  const message = "Failed to fetch dynamically imported module";
  for (const reason of [message, new Error(message), { message }, Object.assign(() => {}, { message })]) {
    guard.clear();
    replace.mockClear();
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
    expect(replace).toHaveBeenCalledOnce();
    expect(new URL(replace.mock.calls[0]?.[0]).searchParams.has("__reload")).toBe(true);
  }

  guard.clear();
  replace.mockClear();
  target.dispatchEvent(Object.assign(new Event("error"), { message: "Loading chunk 123 failed" }));
  expect(replace).toHaveBeenCalledOnce();
});
