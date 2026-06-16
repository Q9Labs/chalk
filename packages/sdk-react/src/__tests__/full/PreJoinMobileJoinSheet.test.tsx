import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PreJoinMobileJoinSheet } from "../../components/full/prejoin-lobby/PreJoinMobileJoinSheet";

describe("PreJoinMobileJoinSheet", () => {
  it("commits the pending display name before joining", async () => {
    const onDisplayNameChange = vi.fn();
    const onJoin = vi.fn();
    const user = userEvent.setup();
    const { getByPlaceholderText, getByRole } = render(<PreJoinMobileJoinSheet displayName="" isLoading={false} onDisplayNameChange={onDisplayNameChange} onJoin={onJoin} />);

    await user.click(getByRole("button", { name: "Your name" }));

    const input = getByPlaceholderText("Your name") as HTMLInputElement;
    await user.type(input, " Hasan ");

    const joinButton = getByRole("button", { name: "Ask to join" }) as HTMLButtonElement;
    expect(joinButton.disabled).toBe(false);

    await act(async () => {
      await user.click(joinButton);
    });

    expect(onDisplayNameChange).toHaveBeenCalledWith("Hasan");
    expect(onJoin).toHaveBeenCalledWith("Hasan");
  });
});
