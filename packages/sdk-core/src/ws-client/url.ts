export const buildWsUrl = (
	baseUrl: string,
	token: string,
	roomId: string,
): string => {
	try {
		const parsed = new URL(baseUrl);
		parsed.searchParams.set("token", token);
		parsed.searchParams.set("room", roomId);
		return parsed.toString();
	} catch {
		const separator = baseUrl.includes("?") ? "&" : "?";
		return `${baseUrl}${separator}token=${encodeURIComponent(token)}&room=${encodeURIComponent(roomId)}`;
	}
};

