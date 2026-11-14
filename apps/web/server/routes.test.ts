import { expect, it } from "vitest";
import { pages } from "./pages";

const functions = import.meta.glob<string>("../functions/dashboard-api/*.ts", { query: "?raw", import: "default", eager: true });
const names = Object.keys(functions).map((path) => path.replace(/^.*\//, "").replace(/\.ts$/, ""));

it("serves a Pages Function for every dashboard page, and none for a page that is gone", () => {
  expect(names.sort()).toEqual([...Object.keys(pages), "favicon"].sort());
});

it("keeps every dashboard Pages Function a re-export of the one handler", () => {
  for (const [path, source] of Object.entries(functions)) {
    expect(source.trim(), path).toBe('export { onRequest } from "../../server/production";');
  }
});
