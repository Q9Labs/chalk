export function deriveWsUrl(apiUrl: string): string {
	try {
		const url = new URL(apiUrl);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.pathname = "/ws";
		return url.toString();
	} catch {
		const wsProtocol = apiUrl.startsWith("https") ? "wss" : "ws";
		const baseUrl = apiUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
		return `${wsProtocol}://${baseUrl}/ws`;
	}
}
