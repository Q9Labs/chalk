import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import z from "zod";
import { getApiUrl, verifyMagicLink } from "../../lib/internalAuth";

export const Route = createFileRoute("/auth/callback")({
	component: AuthCallbackPage,
	validateSearch: z.object({
		token: z.string().optional(),
	}),
});

function AuthCallbackPage() {
	const { token } = Route.useSearch();
	const navigate = useNavigate();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				if (!token) throw new Error("Missing token");
				await verifyMagicLink(getApiUrl(), token);
				if (cancelled) return;
				navigate({ to: "/dashboard", replace: true });
			} catch (e) {
				if (cancelled) return;
				setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [token, navigate]);

	return (
		<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
			<div className="w-full max-w-md space-y-3">
				<h1 className="text-xl font-semibold">Signing you in</h1>
				<p className="text-sm text-muted-foreground">
					{error ? "Sign-in failed." : "Verifying magic link..."}
				</p>
				{error && (
					<pre className="rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
						{error}
					</pre>
				)}
			</div>
		</div>
	);
}

