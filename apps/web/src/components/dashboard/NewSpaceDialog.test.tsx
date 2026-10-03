/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewSpaceDialog } from "./NewSpaceDialog";

const mocks = vi.hoisted(() => ({ createSpace: vi.fn() }));

vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual("../../lib/dashboard-api");
  return { ...actual, createSpace: mocks.createSpace };
});

beforeEach(() => {
  mocks.createSpace.mockResolvedValue({ id: "space-1" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NewSpaceDialog Artifact policies", () => {
  it("sends explicit future-Episode recording and transcript choices and identifies a Tenant ceiling", async () => {
    render(<NewSpaceDialog open onClose={vi.fn()} tenantID="tenant-1" transcriptionCeiling="on_demand" />);

    fireEvent.change(screen.getByLabelText("Space name"), { target: { value: "Design Lab" } });
    fireEvent.change(screen.getByLabelText("Capture"), { target: { value: "automatic" } });
    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "automatic" } });

    expect(screen.getByRole("status").textContent).toContain("limited to On demand");
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));

    await waitFor(() =>
      expect(mocks.createSpace).toHaveBeenCalledWith({
        tenantID: "tenant-1",
        name: "Design Lab",
        slug: "design-lab",
        metadata: undefined,
        admission_policy: { mode: "open" },
        recording_policy: "automatic",
        transcription_policy: "automatic",
      }),
    );
  });

  it.each(["on_demand", "disabled", "automatic"])("starts from the Tenant default %s and resets to it after creation", async (mode) => {
    const onClose = vi.fn();
    render(<NewSpaceDialog open onClose={onClose} tenantID="tenant-1" transcriptionDefaultMode={mode} />);
    expect(screen.getByLabelText("Transcript")).toHaveProperty("value", mode);
    expect(screen.getByLabelText("Capture")).toHaveProperty("value", "automatic");
    fireEvent.change(screen.getByLabelText("Space name"), { target: { value: "New Space" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mocks.createSpace).toHaveBeenCalledWith(expect.objectContaining({ transcription_policy: mode, recording_policy: "automatic" }));
    expect(screen.getByLabelText("Transcript")).toHaveProperty("value", mode);
  });

  it("refreshes defaults when switching Tenants", () => {
    const { rerender } = render(<NewSpaceDialog open onClose={vi.fn()} tenantID="tenant-1" transcriptionDefaultMode="on_demand" />);
    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "automatic" } });
    rerender(<NewSpaceDialog open onClose={vi.fn()} tenantID="tenant-2" transcriptionDefaultMode="disabled" />);
    expect(screen.getByLabelText("Transcript")).toHaveProperty("value", "disabled");
  });

  it("keeps explicit Off choices", async () => {
    render(<NewSpaceDialog open onClose={vi.fn()} tenantID="tenant-1" transcriptionDefaultMode="on_demand" />);
    fireEvent.change(screen.getByLabelText("Space name"), { target: { value: "No Capture" } });
    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "disabled" } });
    fireEvent.change(screen.getByLabelText("Capture"), { target: { value: "disabled" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));
    await waitFor(() => expect(mocks.createSpace).toHaveBeenCalledWith(expect.objectContaining({ transcription_policy: "disabled", recording_policy: "disabled" })));
  });

  it("requires Capture before enabling a Transcript", () => {
    render(<NewSpaceDialog open onClose={vi.fn()} tenantID="tenant-1" />);

    fireEvent.change(screen.getByLabelText("Capture"), { target: { value: "disabled" } });
    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "automatic" } });

    expect(screen.getByRole("alert").textContent).toContain("Transcription requires Capture");
    expect(screen.getByRole("button", { name: "Create Space" })).toHaveProperty("disabled", true);
  });
});
