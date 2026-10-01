import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "./MessageBubble";
import { ChatPanelSurface } from "./ChatPanel";
import { ClassicChatPanelSurface } from "./ClassicChatPanel";
import { ClassicMessageBubble } from "./ClassicMessageBubble";

describe("held chat status", () => {
  it.each([MessageBubble, ClassicMessageBubble])("does not add Pending or Sent to a queued bubble", (Bubble) => {
    const html = renderToStaticMarkup(<Bubble content="held" senderName="You" timestamp="2026-10-01T00:00:00Z" isLocal status="queued" />);
    expect(html).not.toContain("Pending");
    expect(html).not.toContain(">Sent<");
  });
});

it.each([ChatPanelSurface, ClassicChatPanelSurface])("shows Waiting to send exactly once for held chat", (Panel) => {
  const html = renderToStaticMarkup(<Panel messages={[]} localParticipantId="participant" pendingMessages={[{ clientMessageId: "held", text: "held", attachments: [], status: "queued", error: null }]} />);
  expect(html.match(/Waiting to send/g)).toHaveLength(1);
  expect(html).not.toContain("Pending");
});
