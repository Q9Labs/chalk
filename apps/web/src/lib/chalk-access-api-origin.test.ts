import { afterEach, expect, it, vi } from "vitest";
import { publicAPIBaseURL } from "./chalk-access";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("keeps call access and reporting on the same-origin dev proxy without VITE_API_URL", () => {
  vi.stubEnv("VITE_API_URL", "");
  vi.stubGlobal("location", { origin: "http://127.0.0.1:3070" });
  expect(publicAPIBaseURL()).toBe("http://127.0.0.1:3070");
});

it("uses the explicitly configured call API instead of the web origin", () => {
  vi.stubEnv("VITE_API_URL", " https://api.chalk.test ");
  vi.stubGlobal("location", { origin: "http://127.0.0.1:3070" });
  expect(publicAPIBaseURL()).toBe("https://api.chalk.test");
});
