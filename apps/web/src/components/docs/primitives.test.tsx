/* @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Callout, CardGrid, CodeBlock, FeatureCard } from "./primitives";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderCopyableCode(code: string, writeText: (value: string) => Promise<unknown>) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <CodeBlock>
      <code>{code}</code>
    </CodeBlock>,
  );
}

describe("docs primitives", () => {
  it("renders tone, cards, and feature links with accessible structure", () => {
    const markup = renderToStaticMarkup(
      <>
        <Callout tone="caution" title="Check this">
          <p>Admission is capability-gated.</p>
        </Callout>
        <CardGrid>
          <FeatureCard title="TypeScript" href="/docs/typescript" description="Use the client package." />
        </CardGrid>
      </>,
    );

    expect(markup).toContain('data-tone="caution"');
    expect(markup).toContain("Check this");
    expect(markup).toContain('href="/docs/typescript"');
    expect(markup).toContain("Use the client package.");
  });

  it("reports a successful clipboard write without changing code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    renderCopyableCode("const space = await chalk.spaces.create();", writeText);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const space = await chalk.spaces.create();"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByText("const space = await chalk.spaces.create();")).toBeTruthy();
  });

  it("keeps the code readable and exposes a failure message when copy is unavailable", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    renderCopyableCode('await chalk.spaces.get("design-lab");', writeText);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copy failed" })).toBeTruthy();
    expect(screen.getByText("Copy failed. Select the code to copy it manually.")).toBeTruthy();
    expect(screen.getByText('await chalk.spaces.get("design-lab");')).toBeTruthy();
  });
});
