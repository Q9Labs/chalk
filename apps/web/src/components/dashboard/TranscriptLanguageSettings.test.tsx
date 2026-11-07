// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptLanguageSettings } from "./TranscriptLanguageSettings";
import { ToastProvider } from "./kit";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const control = () => screen.getByRole("button", { name: /Transcript language/ });
const pick = (name: string) => {
  fireEvent.click(control());
  fireEvent.change(screen.getByRole("combobox", { name: "Search languages" }), { target: { value: name } });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search languages" }), { key: "Enter" });
};

it("saves a fixed account language and remembers it as recent", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <ToastProvider>
      <TranscriptLanguageSettings value="auto" onSave={save} />
    </ToastProvider>,
  );
  expect(control().textContent).toContain("Auto-detect");
  fireEvent.click(control());
  expect(screen.queryByRole("option", { name: /Use account default/ })).toBeNull();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search languages" }), { key: "Escape" });
  pick("urdu");
  fireEvent.click(screen.getByRole("button", { name: "Save transcript language" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("ur"));
  expect(window.localStorage.getItem("chalk.transcript-language.recent")).toBe('["ur"]');
});

it("distinguishes explicit auto from inheritance and preserves a failed draft", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Try again"));
  const view = render(
    <ToastProvider>
      <TranscriptLanguageSettings value="ar" inherit onSave={save} />
    </ToastProvider>,
  );
  fireEvent.click(control());
  fireEvent.click(screen.getByRole("option", { name: /Auto-detect/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save transcript language" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("auto"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(control().textContent).toContain("Auto-detect");
  expect(window.localStorage.getItem("chalk.transcript-language.recent")).toBeNull();
  save.mockResolvedValue(undefined);
  fireEvent.click(control());
  fireEvent.click(screen.getByRole("option", { name: /Use account default/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save transcript language" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(null));
  view.rerender(
    <ToastProvider>
      <TranscriptLanguageSettings value={null} inherit onSave={save} />
    </ToastProvider>,
  );
  expect(control().textContent).toContain("Use account default");
});

it("shows progress and blocks a second choice while saving", async () => {
  let finish: () => void = () => {};
  const save = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
  render(
    <ToastProvider>
      <TranscriptLanguageSettings value="auto" onSave={save} />
    </ToastProvider>,
  );
  pick("french");
  fireEvent.click(screen.getByRole("button", { name: "Save transcript language" }));
  await waitFor(() => expect(control().getAttribute("aria-busy")).toBe("true"));
  expect(control()).toHaveProperty("disabled", true);
  finish();
  await waitFor(() => expect(control().hasAttribute("aria-busy")).toBe(false));
});
