import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "@/features/docs/components";
import SdkReactContent from "@/features/docs/content/sdk-react.mdx";

export const Route = createFileRoute("/docs/sdk-react")({
	component: SdkReact,
});

function SdkReact() {
	return (
		<DocsLayout>
			<SdkReactContent />
		</DocsLayout>
	);
}
