/**
 * Token Provider for React Native
 * Handles API key → JWT exchange and automatic refresh using AsyncStorage
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY_ACCESS = "chalk_access_token";
const STORAGE_KEY_REFRESH = "chalk_refresh_token";
const STORAGE_KEY_EXPIRES = "chalk_token_expires";

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

interface CreateTokenProviderConfig {
	apiKey: string;
	apiUrl: string;
}

/**
 * Creates a token provider that handles API key → JWT exchange and automatic refresh.
 */
export function createTokenProvider(
	config: CreateTokenProviderConfig,
): () => Promise<string> {
	const { apiKey, apiUrl } = config;

	// Serialize concurrent refresh requests
	let refreshPromise: Promise<string> | null = null;

	async function fetchInitialToken(): Promise<TokenResponse> {
		const response = await fetch(`${apiUrl}/api/v1/auth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: apiKey }),
		});

		if (!response.ok) {
			const err = await response.text().catch(() => "Unknown error");
			throw new Error(`Token exchange failed: ${err}`);
		}

		return response.json();
	}

	async function refreshToken(refreshTok: string): Promise<TokenResponse> {
		const response = await fetch(`${apiUrl}/api/v1/auth/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: refreshTok }),
		});

		if (!response.ok) {
			// Clear tokens on refresh failure
			await AsyncStorage.multiRemove([
				STORAGE_KEY_ACCESS,
				STORAGE_KEY_REFRESH,
				STORAGE_KEY_EXPIRES,
			]);
			throw new Error("Token refresh failed");
		}

		return response.json();
	}

	async function storeTokens(tokens: TokenResponse): Promise<void> {
		const expiresAt = Date.now() + tokens.expires_in * 1000;
		await AsyncStorage.multiSet([
			[STORAGE_KEY_ACCESS, tokens.access_token],
			[STORAGE_KEY_REFRESH, tokens.refresh_token],
			[STORAGE_KEY_EXPIRES, String(expiresAt)],
		]);
	}

	async function isExpired(): Promise<boolean> {
		const expiresStr = await AsyncStorage.getItem(STORAGE_KEY_EXPIRES);
		if (!expiresStr) return true;
		// Refresh 30 seconds before expiry
		return Date.now() > Number(expiresStr) - 30_000;
	}

	return async (): Promise<string> => {
		// Check for existing valid token
		const accessToken = await AsyncStorage.getItem(STORAGE_KEY_ACCESS);
		const expired = await isExpired();

		if (accessToken && !expired) {
			return accessToken;
		}

		// Serialize concurrent requests
		if (refreshPromise) {
			return refreshPromise;
		}

		refreshPromise = (async () => {
			try {
				const refreshTok = await AsyncStorage.getItem(STORAGE_KEY_REFRESH);

				// Try refresh if we have a refresh token
				if (refreshTok) {
					try {
						const tokens = await refreshToken(refreshTok);
						await storeTokens(tokens);
						return tokens.access_token;
					} catch {
						// Refresh failed - fall through to initial token
					}
				}

				// No refresh token or refresh failed - get initial token via API key
				const tokens = await fetchInitialToken();
				await storeTokens(tokens);
				return tokens.access_token;
			} finally {
				refreshPromise = null;
			}
		})();

		return refreshPromise;
	};
}
