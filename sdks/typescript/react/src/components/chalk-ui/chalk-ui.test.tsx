// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { SkinProvider } from "../skin-context";
import { ChalkBadge } from "./ChalkBadge";
import { ChalkAlert } from "./ChalkAlert";
import { ChalkBackdrop } from "./ChalkBackdrop";
import { ChalkButton } from "./ChalkButton";
import { ChalkCheckbox } from "./ChalkCheckbox";
import { ChalkChrome } from "./ChalkChrome";
import { ChalkControlGroup } from "./ChalkControlGroup";
import { ChalkDialogPanel } from "./ChalkDialogPanel";
import { ChalkDivider } from "./ChalkDivider";
import { ChalkEmptyState } from "./ChalkEmptyState";
import { ChalkIconButton } from "./ChalkIconButton";
import { ChalkInput } from "./ChalkInput";
import { ChalkMenu, ChalkMenuItem } from "./ChalkMenu";
import { ChalkPanel } from "./ChalkPanel";
import { ChalkRadio } from "./ChalkRadio";
import { ChalkSelect } from "./ChalkSelect";
import { ChalkSlider } from "./ChalkSlider";
import { ChalkSpinner } from "./ChalkSpinner";
import { ChalkTextarea } from "./ChalkTextarea";
import { ChalkToggle } from "./ChalkToggle";
import { ChalkTooltipPanel } from "./ChalkTooltipPanel";
import { roughRoundedRect } from "./rough";
import { chalkTexture } from "./texture";

describe("chalk-ui primitives", () => {
  afterEach(cleanup);

  it("keeps seeded geometry and texture deterministic", () => {
    const options = { seed: 42, roughness: 1 };
    expect(roughRoundedRect(2, 2, 100, 32, 8, options)).toBe(roughRoundedRect(2, 2, 100, 32, 8, options));
    expect(chalkTexture(42, 1, 0)).toEqual(chalkTexture(42, 1, 0));
    expect(roughRoundedRect(2, 2, 100, 32, 8, options)).not.toBe(roughRoundedRect(2, 2, 100, 32, 8, { ...options, seed: 43 }));
  });

  it("renders decorative SVG chrome during SSR without DOM APIs", () => {
    const markup = renderToStaticMarkup(<ChalkButton seed={7}>Save</ChalkButton>);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain('data-chalk-layer="core"');
    expect(markup).toContain('data-chalk-layer="powder"');
    expect(markup).toContain('data-chalk-layer="edge"');
  });

  it("keeps direct primitives on the chalk skin by default", () => {
    const markup = renderToStaticMarkup(<ChalkButton seed={7}>Save</ChalkButton>);
    expect(markup).toContain('data-chalk-chrome="true"');
  });

  it("renders classic controls without chalk SVG chrome", () => {
    document.documentElement.style.setProperty("--chalk-app-control", "rgb(255 255 255)");
    document.documentElement.style.setProperty("--chalk-app-control-primary", "rgb(26 92 180)");
    document.documentElement.style.setProperty("--chalk-app-danger", "rgb(190 46 56)");
    document.documentElement.style.setProperty("--chalk-app-success", "rgb(28 128 76)");
    document.documentElement.style.setProperty("--chalk-app-line", "rgb(200 200 200)");
    document.documentElement.style.setProperty("--chalk-app-text", "rgb(12 14 18)");
    render(
      <SkinProvider skin="classic">
        <ChalkButton>Save</ChalkButton>
        <ChalkButton tone="danger" variant="solid">
          Delete
        </ChalkButton>
        <ChalkButton tone="success" variant="solid">
          Done
        </ChalkButton>
        <ChalkButton tone="danger" variant="ghost">
          Cancel
        </ChalkButton>
        <ChalkBadge tone="danger">Danger</ChalkBadge>
        <ChalkBadge tone="success">Success</ChalkBadge>
        <ChalkToggle aria-label="Danger toggle" defaultPressed tone="danger" />
        <ChalkToggle aria-label="Success toggle" defaultPressed tone="success" />
        <ChalkAlert tone="success">Success alert</ChalkAlert>
        <ChalkIconButton aria-label="Danger icon" tone="danger">
          !
        </ChalkIconButton>
        <ChalkPanel>Panel</ChalkPanel>
        <ChalkInput aria-label="Name" />
        <ChalkCheckbox aria-label="Agree" />
        <ChalkSelect aria-label="Theme">
          <option value="light">Light</option>
        </ChalkSelect>
      </SkinProvider>,
    );

    expect(document.querySelectorAll("svg[data-chalk-chrome='true']")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("border-[var(--chalk-app-line-strong,var(--chalk-line))]", "bg-[var(--chalk-app-control,var(--chalk-surface))]", "text-[var(--chalk-app-text,var(--chalk-text))]");
    const deleteButton = screen.getByRole("button", { name: "Delete" });
    expect(deleteButton).toHaveClass("bg-[var(--chalk-app-danger,var(--chalk-danger))]", "text-[var(--chalk-app-control-active-text,var(--chalk-accent-text))]");
    expect(deleteButton).not.toHaveClass("bg-[var(--chalk-app-control-primary,var(--chalk-accent))]");
    expect(screen.getByRole("button", { name: "Done" })).toHaveClass("bg-[var(--chalk-app-success,var(--chalk-positive))]");
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton).toHaveClass("border-transparent", "bg-transparent", "text-[var(--chalk-app-danger,var(--chalk-danger))]");
    expect(cancelButton).not.toHaveClass("border-[var(--chalk-app-line,var(--chalk-line))]");
    expect(cancelButton).not.toHaveClass("bg-[var(--chalk-app-control,var(--chalk-surface))]");
    const dangerBadge = screen.getByText("Danger").parentElement;
    const successBadge = screen.getByText("Success").parentElement;
    expect(dangerBadge).toHaveClass("border-[var(--chalk-app-danger,var(--chalk-danger))]");
    expect(successBadge).toHaveClass("border-[var(--chalk-app-success,var(--chalk-positive))]");
    expect(dangerBadge).not.toHaveClass("border-[var(--chalk-app-success,var(--chalk-positive))]");
    const dangerToggle = screen.getByRole("switch", { name: "Danger toggle" });
    const successToggle = screen.getByRole("switch", { name: "Success toggle" });
    expect(dangerToggle).toHaveAttribute("data-chalk-tone", "danger");
    expect(successToggle).toHaveAttribute("data-chalk-tone", "success");
    expect(screen.getByRole("alert")).toHaveClass("border-[var(--chalk-app-success,var(--chalk-positive))]");
    expect(screen.getByRole("button", { name: "Danger icon" })).toHaveClass("border-[var(--chalk-app-danger,var(--chalk-danger))]");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Agree" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeInTheDocument();
  });

  it("keeps native semantics across the primitive set", () => {
    render(
      <ChalkControlGroup>
        <ChalkButton>Button</ChalkButton>
        <ChalkIconButton aria-label="More">+</ChalkIconButton>
        <ChalkPanel>Panel</ChalkPanel>
        <ChalkInput aria-label="Name" />
        <ChalkTextarea aria-label="Notes" />
        <ChalkToggle aria-label="Ready" />
        <ChalkBadge>New</ChalkBadge>
        <ChalkDivider />
      </ChalkControlGroup>,
    );
    expect(screen.getByRole("button", { name: "Button" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Ready" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(document.querySelectorAll("svg[data-chalk-chrome='true']").length).toBeGreaterThan(0);
  });

  it("updates checked state on the real switch button", () => {
    render(<ChalkToggle aria-label="Ready" />);
    const toggle = screen.getByRole("switch", { name: "Ready" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAttribute("data-pressed", "true");
  });

  it("maps loading and disabled state to the native button", () => {
    render(
      <>
        <ChalkButton disabled>Disabled</ChalkButton>
        <ChalkButton loading>Loading</ChalkButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "Disabled" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Loading" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Loading" })).toHaveAttribute("aria-busy", "true");
  });

  it("keeps the focus layer decorative", () => {
    render(
      <>
        <ChalkChrome shape="circle" seed={4} />
        <ChalkButton>Focus me</ChalkButton>
      </>,
    );
    const svg = document.querySelector("svg[data-chalk-chrome='true']");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveStyle({ pointerEvents: "none" });
    const focusPath = svg?.querySelector("path[data-chalk-layer='focus']");
    expect(focusPath).toBeInTheDocument();
    expect(focusPath).toHaveAttribute("opacity", "0");
    expect(focusPath).toHaveClass("opacity-0", "group-focus-visible:opacity-60", "group-focus-within:opacity-60");
    expect(screen.getByRole("button", { name: "Focus me" })).toHaveClass("group");
  });

  it("uses deterministic fallback dimensions without a ResizeObserver", () => {
    render(<ChalkChrome seed={1} />);
    expect(document.querySelector("svg[data-chalk-chrome='true']")).toHaveAttribute("viewBox", "0 0 120 36");
  });

  it("preserves native checked, selected, and range semantics", () => {
    render(
      <>
        <ChalkCheckbox aria-label="Agree" label="Agree" />
        <ChalkRadio aria-label="Choice" name="choice" />
        <ChalkSelect aria-label="Theme" defaultValue="dark">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </ChalkSelect>
        <ChalkSlider aria-label="Volume" defaultValue={5} min={0} max={10} />
      </>,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Agree" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    const radio = screen.getByRole("radio", { name: "Choice" });
    fireEvent.click(radio);
    expect(radio).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
    const slider = screen.getByRole("slider", { name: "Volume" });
    expect(slider).toHaveValue("5");
    fireEvent.change(slider, { target: { value: "8" } });
    expect(slider).toHaveValue("8");
  });

  it("provides accessible presentational replacements", () => {
    render(
      <>
        <ChalkDialogPanel aria-label="Settings">Dialog</ChalkDialogPanel>
        <ChalkBackdrop data-testid="backdrop" />
        <ChalkMenu aria-label="Actions">
          <ChalkMenuItem>Open</ChalkMenuItem>
        </ChalkMenu>
        <ChalkTooltipPanel>Helpful tip</ChalkTooltipPanel>
        <ChalkAlert>Something happened</ChalkAlert>
        <ChalkEmptyState title="Nothing here" description="Try another filter" />
        <ChalkSpinner />
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByTestId("backdrop")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("menu", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("tooltip", { name: "Helpful tip" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(document.querySelectorAll("svg[data-chalk-chrome='true'][aria-hidden='true']").length).toBeGreaterThan(0);
  });
});
