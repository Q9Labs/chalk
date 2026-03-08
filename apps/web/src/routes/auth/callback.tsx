import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import z from "zod";
import { fetchInternalAccessToken, getApiUrl, verifyMagicLink } from "../../lib/internalAuth";

export const Route = createFileRoute("/auth/callback")({
	component: AuthCallbackPage,
	validateSearch: z.object({
		token: z.string().optional(),
		error: z.string().optional(),
	}),
});

function AuthCallbackPage() {
	const { token, error: redirectError } = Route.useSearch();
	const navigate = useNavigate();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				if (redirectError) {
					throw new Error(redirectError);
				}

				const apiUrl = getApiUrl();
				if (token) {
					await verifyMagicLink(apiUrl, token);
				}

				const accessToken = await fetchInternalAccessToken(apiUrl);
				const meetingsResponse = await fetch(`${apiUrl}/api/v1/internal/meetings?limit=1&offset=0`, {
					headers: { Authorization: `Bearer ${accessToken}` },
				});
				if (meetingsResponse.status === 401) {
					throw new Error("Sign-in session was not established. Request a fresh link.");
				}
				if (!meetingsResponse.ok) {
					throw new Error(`dashboard auth check failed (${meetingsResponse.status})`);
				}

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
	}, [navigate, redirectError, token]);

	return (
		<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
			<div className="w-full max-w-md space-y-3">
				<h1 className="text-xl font-semibold">Signing you in</h1>
				<p className="text-sm text-muted-foreground">
					{error ? "Sign-in failed." : "Finalizing dashboard session..."}
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
