// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AudioIndicator } from "./AudioIndicator";
import { Avatar } from "./Avatar";
import { CaptionLine } from "./CaptionLine";
import { ConnectionQuality } from "./ConnectionQuality";
import { HandRaiseIndicator } from "./HandRaiseIndicator";
import { NameTag } from "./NameTag";
import { ReactionBubble } from "./ReactionBubble";
import { Waveform } from "./Waveform";

afterEach(cleanup);

describe("chalk atomic visuals", () => {
  it("frames participant and media indicators with chalk chrome", () => {
    render(
      <>
        <Avatar name="Grace" generated={false} status="online" />
        <AudioIndicator variant="bars" level={70} />
        <ConnectionQuality quality={3} showLabel />
        <HandRaiseIndicator raised />
        <NameTag name="Grace" isLocal />
        <ReactionBubble emoji="🎉" participantName="Grace" duration={1000} />
        <Waveform levels={[20, 60, 40]} />
        <CaptionLine text="Welcome" speaker="Grace" />
      </>,
    );

    expect(screen.getByRole("img", { name: "Avatar for Grace" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Connection quality: Good" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Hand raised" })).toBeInTheDocument();
    expect(document.querySelectorAll('svg[data-chalk-chrome="true"]').length).toBeGreaterThanOrEqual(8);
  });
});
