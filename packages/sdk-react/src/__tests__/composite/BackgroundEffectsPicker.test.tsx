import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { BackgroundEffectsPicker } from "../../components/composite/BackgroundEffectsPicker";

describe("BackgroundEffectsPicker", () => {
  const effects = [
    { id: "blur", type: "blur" as const, name: "Blur" },
    { id: "img1", type: "image" as const, name: "Office", thumbnail: "office.jpg" },
  ];

  it("renders all effect options", () => {
    const { getByLabelText } = render(<BackgroundEffectsPicker effects={effects} onSelect={() => {}} />);
    expect(getByLabelText("No background effect")).toBeDefined();
    expect(getByLabelText("Select Blur")).toBeDefined();
    expect(getByLabelText("Select Office")).toBeDefined();
  });

  it("calls onSelect when an effect is clicked", () => {
    const onSelect = vi.fn();
    const { getByLabelText } = render(<BackgroundEffectsPicker effects={effects} onSelect={onSelect} />);
    fireEvent.click(getByLabelText("Select Blur"));
    expect(onSelect).toHaveBeenCalledWith("blur");
  });

  it("calls onCustomUpload when a file is selected", () => {
    const onCustomUpload = vi.fn();
    const { getByLabelText, container } = render(<BackgroundEffectsPicker effects={[]} onSelect={() => {}} onCustomUpload={onCustomUpload} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([""], "test.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onCustomUpload).toHaveBeenCalledWith(file);
  });
});
