import { describe, expect, it } from "vitest";
import { PRESENTING_FAILURE_REASONS, PRESENTING_FORMATS, presentingAcceptedLabelFor, presentingFailureMessage, presentingFormatIdsFor, presentingMimeTypesFor, resolveFileMimeType } from "./files";

describe("presenting file formats", () => {
  it("accepts only the always-on formats without flags", () => {
    expect(presentingFormatIdsFor()).toEqual(["pdf", "png", "jpeg", "gif", "webp"]);
    expect(presentingAcceptedLabelFor(presentingFormatIdsFor())).toBe("PDF, images");
  });

  it("adds Office formats with the office flag and Keynote only with both flags", () => {
    const office = presentingFormatIdsFor({ office: true });
    expect(office).toEqual(expect.arrayContaining(["pptx", "ppt", "docx", "doc", "xlsx", "xls", "odp", "odt", "ods", "txt"]));
    expect(office).not.toContain("key");
    expect(presentingFormatIdsFor({ keynote: true })).not.toContain("key");
    expect(presentingFormatIdsFor({ office: true, keynote: true })).toContain("key");
    expect(presentingAcceptedLabelFor(office)).toBe("PDF, slides, documents, spreadsheets, text files, images");
  });

  it("keeps one MIME type, extension and id per entry", () => {
    for (const values of [PRESENTING_FORMATS.map((format) => format.id), PRESENTING_FORMATS.flatMap((format) => format.extensions), PRESENTING_FORMATS.flatMap((format) => format.mimeTypes)]) {
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("filters MIME types by the accepted ids", () => {
    expect(presentingMimeTypesFor(["pdf"]).has("application/pdf")).toBe(true);
    expect(presentingMimeTypesFor(["pdf"]).has("application/vnd.ms-excel")).toBe(false);
    expect(presentingMimeTypesFor(["key"]).has("application/x-iwork-keynote-sffkey")).toBe(true);
  });

  it("explains each failure in plain language", () => {
    expect(presentingFailureMessage("password_protected")).toBe("This file is password protected. Remove the password and try again.");
    for (const code of ["corrupt", "too_many_pages", "too_large", "unsupported_format"]) expect(presentingFailureMessage(code)).toBeTruthy();
    expect(presentingFailureMessage("nope")).toBeUndefined();
    expect(new Set(PRESENTING_FAILURE_REASONS.map((reason) => reason.code)).size).toBe(PRESENTING_FAILURE_REASONS.length);
  });
});

describe("resolveFileMimeType", () => {
  it.each([
    ["deck.key", "", "application/vnd.apple.keynote"],
    ["deck.KEY", "application/octet-stream", "application/vnd.apple.keynote"],
    ["old.ppt", "", "application/vnd.ms-powerpoint"],
    ["old.doc", "application/octet-stream", "application/msword"],
    ["old.xls", "", "application/vnd.ms-excel"],
    ["new.xlsx", "application/zip", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["notes.txt", "", "text/plain"],
    ["photo.jpg", "", "image/jpeg"],
    ["noext", "", ""],
    ["archive.zip", "application/zip", "application/zip"],
  ])("%s reported as %j resolves to %j", (fileName, reported, expected) => {
    expect(resolveFileMimeType(fileName, reported)).toBe(expected);
  });

  it("keeps a specific type the browser already reported", () => {
    expect(resolveFileMimeType("deck.pptx", "application/pdf")).toBe("application/pdf");
  });
});
