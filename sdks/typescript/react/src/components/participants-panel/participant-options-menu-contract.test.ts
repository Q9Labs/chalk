import { describe, expect, it, vi } from "vitest";

import { runParticipantAction } from "./participant-options-menu-contract";

describe("runParticipantAction", () => {
  it("closes the menu and clears the command error after an async action succeeds", async () => {
    const onClose = vi.fn();
    const onCommandError = vi.fn();

    await runParticipantAction(async () => undefined, onClose, onCommandError);

    expect(onCommandError).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the menu open and reports an Error message when an action fails", async () => {
    const onClose = vi.fn();
    const onCommandError = vi.fn();

    await runParticipantAction(() => Promise.reject(new Error("Participant is unavailable.")), onClose, onCommandError);

    expect(onCommandError).toHaveBeenCalledWith("Participant is unavailable.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports a safe fallback for a synchronous non-Error throw", async () => {
    const onClose = vi.fn();
    const onCommandError = vi.fn();

    await runParticipantAction(
      () => {
        throw "network failure";
      },
      onClose,
      onCommandError,
    );

    expect(onCommandError).toHaveBeenCalledWith("This Participant action could not be completed.");
    expect(onClose).not.toHaveBeenCalled();
  });
});
