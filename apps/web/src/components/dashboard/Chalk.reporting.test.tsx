// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Chalk } from "../../../../../sdks/typescript/react/src/components/chalk/Chalk";
import { createSpaceClientForPlatform } from "../../../../../sdks/typescript/client/src/space-client/space-client";
import { opaqueAccessGrant } from "../../../../../sdks/typescript/client/src/space-client/core.test.helpers";
import { terminalTestPlatform } from "../../../../../sdks/typescript/client/src/space-client/terminal.test.helpers";
vi.mock("../../../../../sdks/typescript/react/src/components/space-view/SpaceView", async () => {
  const { SpaceHeader } = await import("../../../../../sdks/typescript/react/src/components/space-header/SpaceHeader");
  return { SpaceView: (props: Omit<React.ComponentProps<typeof SpaceHeader>, "spaceName">) => <SpaceHeader {...props} spaceName="Judge R8" /> };
});
it("keeps the live report draft when the actual Chalk view becomes terminal", async () => {
  const platform = terminalTestPlatform();
  const client = createSpaceClientForPlatform({ space: "judge-r8", getAccess: async () => opaqueAccessGrant(1) }, { ...platform, fetch: async () => new Response(null, { status: 204 }) });
  try {
    render(<Chalk client={client} onReportProblem={vi.fn().mockResolvedValue(undefined)} />);
    await act(async () => vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live")));
    fireEvent.click(screen.getByRole("button", { name: "Call details", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Report a problem", exact: true }));
    const input = screen.getByLabelText<HTMLTextAreaElement>("What went wrong?");
    fireEvent.change(input, { target: { value: "Keep this live report draft" } });
    await act(async () => platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "episode_ended" } }));
    expect(screen.queryByLabelText("What went wrong?")).toBe(input);
    expect(input.value).toBe("Keep this live report draft");
  } finally {
    cleanup();
    client.dispose();
  }
});
