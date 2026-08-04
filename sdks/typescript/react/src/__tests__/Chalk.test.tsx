// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { Chalk } from "../index";

describe("Chalk public component", () => {
  it("is exported as a React component", () => {
    expect(typeof Chalk).toBe("function");
  });
});
