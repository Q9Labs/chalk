import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/features/docs/components";

export const Route = createFileRoute("/docs/components")({
  component: Components,
});

function Components() {
  return (
    <DocsLayout>
      <div className="space-y-6">
        <h1 className="text-4xl font-bold text-foreground">Components Reference</h1>
        <p className="text-lg text-muted-foreground">Complete reference for UI components at all three tiers: Turnkey, Composable, and Atomic.</p>

        <div className="p-6 rounded-lg border border-amber-500/30 bg-amber-500/10">
          <p className="text-amber-700 dark:text-amber-300 font-medium">
            This page is under construction. See the{" "}
            <a href="/docs/sdk-react" className="underline">
              SDK React overview
            </a>{" "}
            for component documentation.
          </p>
        </div>
      </div>
    </DocsLayout>
  );
}
