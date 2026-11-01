import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseTranscriptLanguage, parseTranscriptLanguageMode, transcriptLanguageValue, whisperLanguageCodes } from "./index";
it("accepts exactly the primary codes published by the API", () => {
  const contract = JSON.parse(readFileSync(new URL("../../../contract/generated/openapi.json", import.meta.url), "utf8"));
  for (const schema of ["Space", "CreateSpaceRequest", "UpdateSpaceRequest"]) expect(contract.components.schemas[schema].properties.transcript_language.enum).toContain(null);
  const values = contract.components.schemas.Tenant.properties.transcript_language.enum;
  expect(values).toEqual(["auto", ...whisperLanguageCodes]);
  for (const value of values) expect(transcriptLanguageValue(parseTranscriptLanguage(value))).toBe(value);
  for (const value of [null, "", "EN", "en-US", "english", "xx", " auto "]) expect(() => parseTranscriptLanguage(value)).toThrow();
  for (const value of [{ mode: "fixed", language: "auto" }, { mode: "auto", language: "en" }, { mode: "fixed", language: "en-US" }, { mode: "unknown" }]) expect(() => parseTranscriptLanguageMode(value)).toThrow();
  expect(parseTranscriptLanguageMode({ mode: "fixed", language: "ur" })).toEqual({ mode: "fixed", language: "ur" });
});
