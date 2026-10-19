import type { KeyboardEvent } from "react";
export function ChalkSegmentedControl<Value extends string>({
  label,
  value,
  options,
  onValueChange,
  size = "default",
}: {
  readonly label: string;
  readonly size?: "default" | "compact";
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly onValueChange: (value: Value) => void;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (options.findIndex((option) => option.value === value) + delta + options.length) % options.length;
    const next = options[index];
    if (next) {
      onValueChange(next.value);
      event.currentTarget.querySelectorAll("button")[index]?.focus();
    }
  };
  return (
    <div data-part="segmented-control" data-size={size} role="group" aria-label={label} className="chalk-segmented" onKeyDown={move}>
      {options.map((option) => (
        <button key={option.value} data-part="segment" type="button" aria-pressed={value === option.value} tabIndex={value === option.value ? 0 : -1} onClick={() => onValueChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
