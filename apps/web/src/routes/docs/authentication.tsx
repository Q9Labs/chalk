import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/features/docs/components";
import AuthenticationContent from "@/features/docs/content/authentication.mdx";

export const Route = createFileRoute("/docs/authentication")({
	component: Authentication,
});

function Authentication() {
	return (
		<DocsLayout>
			<AuthenticationContent />
		</DocsLayout>
	);
}
