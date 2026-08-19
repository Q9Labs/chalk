import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./FeedbackSheet.tsx", import.meta.url), "utf8");

describe("FeedbackSheet", () => {
  it("keeps the first form small and sends through the public Feedback controller", () => {
    expect(source).toContain('<Text accessibilityRole="header"');
    expect(source).toContain("Bug");
    expect(source).toContain("Feature request");
    expect(source).toContain("Other");
    expect(source).toContain("Refresh");
    expect(source).toContain("Remove");
    expect(source).toContain("client.feedback.prepare");
    expect(source).toContain("request.send");
    expect(source).not.toContain("client.feedback.send");
    expect(source).toContain("setPrepared(undefined)");
    expect(source).toContain("no reply channel");
  });

  it("does not put credentials or the feedback modal in the capture adapter", () => {
    expect(source).not.toContain("credential:");
    expect(source).not.toContain("captureRef");
    expect(source).toContain("captureNativeFeedbackView");
  });
});
