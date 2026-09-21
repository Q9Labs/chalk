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

  it("requires Capture before enabling a Transcript", () => {
    render(<NewSpaceDialog open onClose={vi.fn()} tenantID="tenant-1" />);

    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "automatic" } });

    expect(screen.getByRole("alert").textContent).toContain("Transcription requires Capture");
    expect(screen.getByRole("button", { name: "Create Space" })).toHaveProperty("disabled", true);
  });
});
