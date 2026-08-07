import { describe, expect, it } from "vitest";
import { decodeBase64Url } from "./base64-url";

describe("base64url decoding", () => {
  it("decodes URL-safe replacements and omitted padding as UTF-8", () => {
    expect(decodeBase64Url("5Ke_8J-YgA")).toBe("䧿😀");
  });

  it("decodes an empty segment", () => {
    expect(decodeBase64Url("")).toBe("");
  });
});
