import { describe, expect, it } from "vitest";

import { phoneMeetingPanelContentFrame, phoneMeetingPanelSheetFrame } from "./phone-panel-layout";

describe("phoneMeetingPanelSheetFrame", () => {
  it("uses a bounded explicit height so the phone panel cannot collapse to header-only content", () => {
    expect(phoneMeetingPanelSheetFrame.height).toBe("82%");
    expect(phoneMeetingPanelSheetFrame.minHeight).toBeGreaterThanOrEqual(360);
    expect("maxHeight" in phoneMeetingPanelSheetFrame).toBe(false);
    expect(phoneMeetingPanelSheetFrame.overflow).toBe("hidden");
  });

  it("keeps inner content stretchable so chat scroll and composer can fill the sheet", () => {
    expect(phoneMeetingPanelContentFrame).toEqual({
      flex: 1,
      minHeight: 0,
    });
  });
});
