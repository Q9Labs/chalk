import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { pages } from "./pages";

const functions = new URL("../functions/dashboard-api/", import.meta.url);

it("serves a Pages Function for every dashboard page, and none for a page that is gone", () => {
  const files = readdirSync(functions).map((file) => file.replace(/\.ts$/, ""));
  expect(files.sort()).toEqual([...Object.keys(pages), "favicon"].sort());
});

it("keeps every dashboard Pages Function a re-export of the one handler", () => {
  for (const file of readdirSync(functions)) {
    expect(readFileSync(new URL(file, functions), "utf8").trim(), file).toBe('export { onRequest } from "../../server/production";');
  }
});
