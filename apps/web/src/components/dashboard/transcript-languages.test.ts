// @vitest-environment jsdom
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { whisperLanguageCodes } from "@chalk/transcript-language";
import { beforeEach, expect, it } from "vitest";
import { languageOptions, languageName, readNewCallLanguage, readRecentLanguages, rememberLanguage, saveNewCallLanguage, searchLanguages, splitMatch, suggestedLanguages } from "./transcript-languages";

beforeEach(() => window.localStorage.clear());

it("lists every language the API accepts, each with a name and a flag file that exists", () => {
  expect(languageOptions.map((item) => item.code).sort()).toEqual([...whisperLanguageCodes].sort());
  for (const item of languageOptions) {
    expect(item.name).not.toBe(item.code);
    if (item.flag) expect(existsSync(resolve(import.meta.dirname, "../../../public", item.flag.slice(1))), item.flag).toBe(true);
  }
  expect(languageOptions.filter((item) => !item.flag).map((item) => item.code)).toEqual(["bo", "yi"]);
});

it("puts names that start with the text before names that contain it", () => {
  const hits = searchLanguages("ur");
  expect(hits[0]).toMatchObject({ rank: "best", option: { code: "ur" } });
  const names = hits.map((hit) => hit.option.name);
  expect(names).toEqual(expect.arrayContaining(["Burmese", "Luxembourgish", "Turkish", "Turkmen"]));
  expect(hits.filter((hit) => hit.rank === "contains").every((hit) => hit.option.name.toLowerCase().includes("ur"))).toBe(true);
});

it("matches the native name, the code and letters without accents", () => {
  expect(searchLanguages("اردو")[0]?.option.code).toBe("ur");
  expect(searchLanguages("fr")[0]?.option.code).toBe("fr");
  expect(searchLanguages("español")[0]?.option.code).toBe("es");
  expect(searchLanguages("espanol")[0]?.option.code).toBe("es");
  expect(searchLanguages("klingon")).toEqual([]);
  expect(searchLanguages("  ")).toEqual([]);
});

it("splits a name around the match so it can be marked", () => {
  expect(splitMatch("Turkish", "ur")).toEqual(["T", "ur", "kish"]);
  expect(splitMatch("Urdu", "xyz")).toEqual(["Urdu", "", ""]);
});

it("names automatic detection and each language", () => {
  expect(languageName("auto")).toBe("Auto-detect");
  expect(languageName("ur")).toBe("Urdu");
  expect(languageName("jw")).toBe("Javanese");
});

it("remembers the last three languages, newest first, and ignores junk", () => {
  expect(readRecentLanguages()).toEqual([]);
  for (const code of ["ur", "en", "ar", "hi", "en"] as const) rememberLanguage(code);
  expect(readRecentLanguages()).toEqual(["en", "hi", "ar"]);
  window.localStorage.setItem("chalk.transcript-language.recent", '["xx","fr",7]');
  expect(readRecentLanguages()).toEqual(["fr"]);
  window.localStorage.setItem("chalk.transcript-language.recent", "not json");
  expect(readRecentLanguages()).toEqual([]);
});

it("keeps the language for new calls and falls back to the account default", () => {
  expect(readNewCallLanguage()).toBeNull();
  saveNewCallLanguage("ur");
  expect(readNewCallLanguage()).toBe("ur");
  saveNewCallLanguage("auto");
  expect(readNewCallLanguage()).toBe("auto");
  saveNewCallLanguage(null);
  expect(readNewCallLanguage()).toBeNull();
  window.localStorage.setItem("chalk.transcript-language.new-call", "klingon");
  expect(readNewCallLanguage()).toBeNull();
});

it("suggests the browser's supported languages first, then common ones, without repeats", () => {
  expect(suggestedLanguages([], ["fr-CA", "xx", "en-US"])).toEqual(["fr", "en", "ur", "ar"]);
  expect(suggestedLanguages(["fr"], ["fr-CA"])).toEqual(["en", "ur", "ar", "hi"]);
});
