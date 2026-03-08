import { APIClient, type RoomResource } from "@q9labs/chalk-core";

type JoinContextV1 = {
	joinToken: string;
	roomName?: string;
	accessToken?: string;
	expiresAtMs?: number;
};

const JOIN_CONTEXT_KEY = "chalk_join_context_v1";
const verifiedMagicLinks = new Set<string>();
const inFlightMagicLinkVerifications = new Map<string, Promise<void>>();

export function getApiUrl() {
	return import.meta.env.VITE_API_URL || "https://chalk-api.q9labs.ai";
}

export function getJoinContext(): JoinContextV1 | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = sessionStorage.getItem(JOIN_CONTEXT_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as JoinContextV1;
	} catch {
		return null;
	}
}

export function setJoinContext(ctx: JoinContextV1) {
	if (typeof window === "undefined") return;
	sessionStorage.setItem(JOIN_CONTEXT_KEY, JSON.stringify(ctx));
}

export function clearJoinContext() {
	if (typeof window === "undefined") return;
	sessionStorage.removeItem(JOIN_CONTEXT_KEY);
}

export async function fetchInternalAccessToken(apiUrl: string) {
	const res = await fetch(`${apiUrl}/api/v1/internal/auth/access-token`, {
		method: "GET",
		credentials: "include",
	});
	if (!res.ok) {
		throw new Error(`auth failed (${res.status})`);
	}
	const data = (await res.json()) as { access_token: string };
	if (!data.access_token) throw new Error("missing access token");
	return data.access_token;
}

export async function startMagicLink(apiUrl: string, email: string) {
	const callbackUrl =
		typeof window === "undefined"
			? undefined
			: `${window.location.origin}/auth/callback`;

	const res = await fetch(`${apiUrl}/api/v1/internal/auth/start`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, callback_url: callbackUrl }),
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(data?.error || `failed to send email (${res.status})`);
	}
}

export async function verifyMagicLink(apiUrl: string, token: string) {
	const verificationKey = `${apiUrl}::${token}`;
	if (verifiedMagicLinks.has(verificationKey)) {
		return;
	}

	const existingRequest = inFlightMagicLinkVerifications.get(verificationKey);
	if (existingRequest) {
		await existingRequest;
		return;
	}

	const request = (async () => {
		const res = await fetch(`${apiUrl}/api/v1/internal/auth/verify`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		if (!res.ok) {
			const data = (await res.json().catch(() => null)) as {
				error?: string;
			} | null;
			throw new Error(data?.error || `invalid link (${res.status})`);
		}
		verifiedMagicLinks.add(verificationKey);
	})().finally(() => {
		inFlightMagicLinkVerifications.delete(verificationKey);
	});

	inFlightMagicLinkVerifications.set(verificationKey, request);
	await request;
}

export async function exchangeJoinToken(apiUrl: string, joinToken: string) {
	const client = new APIClient({ apiUrl });
	const response = await client.exchangeJoinToken(joinToken);
	if (!response.success || !response.data) {
		throw new Error(response.error?.message ?? "invalid join link");
	}

	return {
		access_token: response.data.accessToken,
		expires_in: response.data.expiresIn,
		room_name: response.data.roomName,
	};
}

export async function getRoomWithAccessToken(apiUrl: string, accessToken: string, roomId: string): Promise<RoomResource> {
	const client = new APIClient({ apiUrl, token: accessToken });
	const response = await client.getRoom(roomId);
	if (!response.success || !response.data) {
		throw new Error(response.error?.message ?? "failed to load room");
	}
	return response.data;
}

export function createWebTokenProvider(apiUrl: string) {
	return async () => {
		const jc = getJoinContext();
		if (jc?.joinToken) {
			if (
				jc.accessToken &&
				jc.expiresAtMs &&
				Date.now() < jc.expiresAtMs - 5_000
			) {
				return jc.accessToken;
			}

			const ex = await exchangeJoinToken(apiUrl, jc.joinToken);
			const expiresAtMs = Date.now() + ex.expires_in * 1000;
			setJoinContext({
				joinToken: jc.joinToken,
				roomName: ex.room_name,
				accessToken: ex.access_token,
				expiresAtMs,
			});
			return ex.access_token;
		}

		return await fetchInternalAccessToken(apiUrl);
	};
}
