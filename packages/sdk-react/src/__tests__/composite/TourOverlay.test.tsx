import { describe, it, expect, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { TourOverlay } from "../../components/composite/TourOverlay";

describe("TourOverlay", () => {
  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  const steps = [
    { target: "#btn1", title: "Step 1", description: "Description 1" },
    { target: "#btn2", title: "Step 2", description: "Description 2" },
  ];

  it("renders correctly when open and target exists", () => {
    const btn = document.createElement("button");
    btn.id = "btn1";
    btn.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        width: 100,
        height: 100,
        bottom: 100,
        right: 100,
      }) as any;
    document.body.appendChild(btn);

    const { getByText, getByRole } = render(<TourOverlay steps={steps} currentStep={1} isOpen={true} onNext={() => {}} onPrev={() => {}} onSkip={() => {}} onComplete={() => {}} />);

    expect(getByRole("dialog")).toBeDefined();
    expect(getByText("Step 1")).toBeDefined();

    document.body.removeChild(btn);
  });

  it("returns null when closed", () => {
    const { container } = render(<TourOverlay steps={steps} currentStep={1} isOpen={false} onNext={() => {}} onPrev={() => {}} onSkip={() => {}} onComplete={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
