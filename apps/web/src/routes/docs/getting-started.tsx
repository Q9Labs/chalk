import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/features/docs/components";
import GettingStartedContent from "@/features/docs/content/getting-started.mdx";

export const Route = createFileRoute("/docs/getting-started")({
	component: GettingStarted,
});

function GettingStarted() {
	return (
		<DocsLayout>
			<GettingStartedContent />
		</DocsLayout>
	);
}
