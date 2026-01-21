import "@/styles/globals.css";
// Import Chalk SDK styles in JS (required for Next.js - CSS @import from node_modules doesn't work)
import "@q9labs/chalk-ui/styles.css";
import "@q9labs/chalk-react/styles.css";
import { ChalkProvider } from "@q9labs/chalk-react";
import type { AppProps } from "next/app";

const CHALK_API_URL =
	process.env.NEXT_PUBLIC_CHALK_API_URL || "https://chalk-api.q9labs.ai";

export default function App({ Component, pageProps }: AppProps) {
	return (
		<ChalkProvider
			debug={true}
			apiUrl={CHALK_API_URL}
			tokenProvider={async () => {
				// First check if we have a stored access token
				const storedToken = sessionStorage.getItem("chalk_access_token");
				const storedRefresh = sessionStorage.getItem("chalk_refresh_token");

				// If we have a refresh token, try to refresh
				if (storedRefresh) {
					try {
						const response = await fetch(
							`${CHALK_API_URL}/api/v1/auth/refresh`,
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
								},
								body: JSON.stringify({ refresh_token: storedRefresh }),
							},
						);

						if (response.ok) {
							const data = await response.json();
							const newAccessToken = data.accessToken || data.access_token;
							const newRefreshToken = data.refreshToken || data.refresh_token;

							if (newAccessToken) {
								sessionStorage.setItem("chalk_access_token", newAccessToken);
							}
							if (newRefreshToken) {
								sessionStorage.setItem("chalk_refresh_token", newRefreshToken);
							}

							return newAccessToken;
						}
					} catch (e) {
						console.warn("Token refresh failed, getting new token");
					}

					// Refresh failed, clear stored tokens
					sessionStorage.removeItem("chalk_access_token");
					sessionStorage.removeItem("chalk_refresh_token");
				}

				// No refresh token or refresh failed - get new tokens from our API route
				try {
					const response = await fetch("/api/chalk/token", {
						method: "POST",
					});

					if (!response.ok) {
						throw new Error("Failed to get token from API");
					}

					const data = await response.json();
					const accessToken = data.accessToken;
					const refreshToken = data.refreshToken;

					if (accessToken) {
						sessionStorage.setItem("chalk_access_token", accessToken);
					}
					if (refreshToken) {
						sessionStorage.setItem("chalk_refresh_token", refreshToken);
					}

					return accessToken || "";
				} catch (e) {
					console.error("Failed to get auth token:", e);
					return "";
				}
			}}
		>
			<Component {...pageProps} />
		</ChalkProvider>
	);
}
