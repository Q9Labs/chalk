import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PREVIEW_DIALOGS, PREVIEW_PANELS, PREVIEW_STAGES } from "./preview-state";

const controlsSource = readFileSync(new URL("./DevSdkPreviewControls.tsx", import.meta.url), "utf8");

describe("native SDK preview controls", () => {
  it("keeps the supported production control contract visible", () => {
    expect(PREVIEW_PANELS).toEqual(["none", "chat", "participants"]);
    expect(PREVIEW_STAGES).toEqual(["people", "whiteboard"]);
    expect(PREVIEW_DIALOGS).toEqual(["none", "more", "settings", "reactions"]);
    expect(controlsSource).toContain('ChoiceGroup label="Sheet"');
    expect(controlsSource).toContain("PREVIEW_STAGES");
    expect(controlsSource).toContain("createPreviewDeepLink(search)");
  });

  it("retains the collapsed chrome restore affordance", () => {
    expect(controlsSource).toContain('onSearchChange({ chrome: "hidden" })');
    expect(controlsSource).toContain('onSearchChange({ chrome: "visible" })');
    expect(controlsSource).toContain('"Show preview controls"');
    expect(controlsSource).not.toContain("PREVIEW_TOASTS");
    expect(controlsSource).not.toContain("Screen share");
  });
});
