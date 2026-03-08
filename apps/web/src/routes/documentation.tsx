import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/documentation")({
	component: DocumentationRedirectPage,
});

function DocumentationRedirectPage() {
	const navigate = useNavigate();

	useEffect(() => {
		void navigate({ to: "/docs", replace: true });
	}, [navigate]);

	return null;
}
