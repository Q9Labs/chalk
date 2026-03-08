import { describe, it, expect, vi } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ParticipantList } from "../../components/composite/ParticipantList";

describe("ParticipantList", () => {
  const participants = [
    { id: "1", displayName: "Alice", role: "host" as const, isLocal: true },
    { id: "2", displayName: "Bob", isMuted: true },
  ];

  it("renders participant names", () => {
    const { getByText } = render(
      <ParticipantList participants={participants} />,
    );
    expect(getByText("Alice")).toBeDefined();
    expect(getByText("Bob")).toBeDefined();
    expect(getByText("(you)")).toBeDefined();
  });

  it("filters participants by search", async () => {
    const user = userEvent.setup();
    const { getByPlaceholderText, queryByText } = render(
      <ParticipantList participants={participants} />,
    );
    const searchInput = getByPlaceholderText("Search participants...");
    await user.type(searchInput, "Alice");
    expect(queryByText("Alice")).toBeDefined();
    expect(queryByText("Bob")).toBeNull();
  });

  it("shows badge with participant count", () => {
    const { getByText } = render(
      <ParticipantList participants={participants} />,
    );
    expect(getByText("2")).toBeDefined();
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <ParticipantList participants={participants} onClose={onClose} />,
    );
    fireEvent.click(getByLabelText("Close participant list"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets the local participant update their own display name", async () => {
    const user = userEvent.setup();
    const onUpdateDisplayName = vi.fn();
    const { getByText, getByDisplayValue } = render(
      <ParticipantList
        participants={participants}
        onUpdateDisplayName={onUpdateDisplayName}
      />,
    );

    await user.click(getByText("Alice"));
    const input = getByDisplayValue("Alice");
    await user.clear(input);
    await user.type(input, "Alicia");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onUpdateDisplayName).toHaveBeenCalledWith("Alicia");
  });

  it("calls onMakeCoHost when Make Co-Host clicked", async () => {
    const user = userEvent.setup();
    const onMakeCoHost = vi.fn();
    const participantsWithRegular = [
      { id: "1", displayName: "Alice", role: "host" as const, isLocal: true },
      { id: "2", displayName: "Bob", role: "participant" as const },
    ];
    const { getByLabelText, getByText } = render(
      <ParticipantList
        participants={participantsWithRegular}
        onMakeCoHost={onMakeCoHost}
        canManageParticipants={true}
      />,
    );
    // Open menu for Bob
    await user.click(getByLabelText("Options for Bob"));
    // Click Make Co-Host
    await user.click(getByText("Make Co-Host"));
    expect(onMakeCoHost).toHaveBeenCalledWith("2");
  });

  it("mutes participant volume when mute icon clicked", async () => {
    const user = userEvent.setup();
    const onParticipantVolumeChange = vi.fn();
    const participantVolumes = new Map([["2", 60]]);
    const { getByLabelText } = render(
      <ParticipantList
        participants={participants}
        participantVolumes={participantVolumes}
        onParticipantVolumeChange={onParticipantVolumeChange}
      />,
    );

    // Volume control should be accessible even when canManageParticipants=false
    await user.click(getByLabelText("Options for Bob"));
    await user.click(getByLabelText("Mute volume"));
    expect(onParticipantVolumeChange).toHaveBeenCalledWith("2", 0);
  });
});
