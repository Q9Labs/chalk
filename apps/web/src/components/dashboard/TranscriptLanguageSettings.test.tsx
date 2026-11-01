// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TranscriptLanguageSettings } from "./TranscriptLanguageSettings";
import { ToastProvider } from "./kit";
afterEach(cleanup);
it("saves a fixed account language and shows all supported languages", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <ToastProvider>
      <TranscriptLanguageSettings value="auto" onSave={save} />
    </ToastProvider>,
  );
  const control = screen.getByRole("combobox", { name: "Transcript language" });
  expect(control).toHaveProperty("value", "auto");
  expect(screen.queryByRole("option", { name: "Use account default" })).toBeNull();
  expect(screen.getByRole("option", { name: "French" })).toBeTruthy();
  fireEvent.change(control, { target: { value: "ur" } });
  fireEvent.click(screen.getByRole("button", { name: "Save transcript language" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("ur"));
});
it("distinguishes explicit auto from inheritance and preserves a failed draft", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Try again"));
  const view = render(
    <ToastProvider>
      <TranscriptLanguageSettings value="ar" inherit onSave={save} />
    </ToastProvider>,
  );
  const control = screen.getByRole("combobox", { name: "Transcript language" });
  fireEvent.change(control, { target: { value: "auto" } });
  fireEvent.click(screen.getByRole("button", { name: "Save transcript language" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("auto"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(control).toHaveProperty("value", "auto");
  save.mockResolvedValue(undefined);
  fireEvent.change(control, { target: { value: "inherit" } });
  fireEvent.click(screen.getByRole("button", { name: "Save transcript language" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(null));
  view.rerender(
    <ToastProvider>
      <TranscriptLanguageSettings value={null} inherit onSave={save} />
    </ToastProvider>,
  );
  expect(control).toHaveProperty("value", "inherit");
});
