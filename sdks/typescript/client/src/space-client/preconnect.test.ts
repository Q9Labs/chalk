import { afterEach, expect, it, vi } from "vitest";
import { preconnect } from "./preconnect";

type FakeLink = { rel: string; href: string; crossOrigin: string };

function stubDocument(): FakeLink[] {
  const links: FakeLink[] = [];
  vi.stubGlobal("document", {
    createElement: () => ({ rel: "", href: "", crossOrigin: "" }),
    head: {
      appendChild: (link: FakeLink) => links.push(link),
      querySelector: (selector: string) => links.find((link) => selector === `link[rel="preconnect"][href="${link.href}"]`) ?? null,
    },
  });
  return links;
}

afterEach(() => vi.unstubAllGlobals());

it("hints the API and Sync origins once, in CORS mode", () => {
  const links = stubDocument();
  preconnect({ baseUrl: "https://api.example.test/", syncUrl: "wss://sync.example.test/v1/sync" });
  preconnect({ baseUrl: "https://api.example.test/", syncUrl: "wss://sync.example.test/v1/sync" });
  expect(links).toEqual([
    { rel: "preconnect", href: "https://api.example.test", crossOrigin: "anonymous" },
    { rel: "preconnect", href: "https://sync.example.test", crossOrigin: "anonymous" },
  ]);
});

it("derives the Sync origin from the base URL the way createSpaceClient does", () => {
  const links = stubDocument();
  preconnect({ baseUrl: "https://api.example.test" });
  expect(links.map((link) => link.href)).toEqual(["https://api.example.test", "https://sync.example.test"]);
});

it("hints one origin when API and Sync share a host", () => {
  const links = stubDocument();
  preconnect({ baseUrl: "http://localhost:8080" });
  expect(links.map((link) => link.href)).toEqual(["http://localhost:8080"]);
});

it("does nothing outside a browser page", () => {
  vi.stubGlobal("document", undefined);
  expect(() => preconnect({ baseUrl: "https://api.example.test" })).not.toThrow();
});
