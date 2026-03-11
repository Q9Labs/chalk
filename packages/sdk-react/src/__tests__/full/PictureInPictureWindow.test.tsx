import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";

import { PictureInPictureWindow } from "../../components/full/picture-in-picture/PictureInPictureWindow";

function participant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "participant" as const,
    title: id.toUpperCase(),
    subtitle: "Live",
    videoTrack: null,
    isMuted: false,
    isSpeaking: false,
    ...overrides,
  };
}

describe("PictureInPictureWindow", () => {
  it("renders a split layout for two participants", () => {
    const { getByTestId, getAllByTestId } = render(
      <PictureInPictureWindow
        phase="meeting"
        source={participant("a")}
        participantSources={[participant("a"), participant("b")]}
        meetingLayout="split"
        controls={{}}
        onReturnToTab={() => {}}
      />,
    );

    expect(getByTestId("pip-layout")).toHaveAttribute("data-layout", "split");
    expect(getAllByTestId("pip-tile")).toHaveLength(2);
  });

  it("renders an overflow tile in grid mode", () => {
    const { getByLabelText, getByTestId, getAllByTestId } = render(
      <PictureInPictureWindow
        phase="meeting"
        source={participant("a")}
        participantSources={[participant("a"), participant("b"), participant("c"), { id: "overflow:2", kind: "placeholder", title: "+2", subtitle: "more" }]}
        meetingLayout="grid"
        controls={{}}
        onReturnToTab={() => {}}
      />,
    );

    expect(getByTestId("pip-layout")).toHaveAttribute("data-layout", "grid");
    expect(getAllByTestId("pip-tile")).toHaveLength(4);
    expect(getByLabelText("PiP overflow +2")).toBeDefined();
  });

  it("renders a screen-share layout with side participants", () => {
    const { getByTestId, getAllByTestId } = render(
      <PictureInPictureWindow
        phase="meeting"
        source={{ id: "screen", kind: "screen-share", title: "Teacher", subtitle: "Screen sharing", videoTrack: null }}
        participantSources={[participant("a"), participant("b")]}
        meetingLayout="screen-share"
        controls={{}}
        onReturnToTab={() => {}}
      />,
    );

    expect(getByTestId("pip-layout")).toHaveAttribute("data-layout", "screen-share");
    expect(getAllByTestId("pip-tile")).toHaveLength(3);
  });

  it("shows a join error in prejoin PiP", () => {
    const { getByText, getAllByText, queryByText } = render(
      <PictureInPictureWindow
        phase="prejoin"
        source={participant("a")}
        controls={{ errorMessage: "Failed to join room", supportCode: "CHK-123" }}
        onReturnToTab={() => {}}
      />,
    );

    expect(getByText("Unable to join room")).toBeDefined();
    expect(getAllByText("Failed to join room")).toHaveLength(2);
    expect(getByText("Technical details")).toBeDefined();
    expect(getByText("Support code")).toBeDefined();
    expect(getByText("CHK-123")).toBeDefined();
    expect(queryByText("You're not in the room yet")).toBeNull();
    expect(queryByText("Join Now")).toBeNull();
  });
});
