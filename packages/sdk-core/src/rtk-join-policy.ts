import { detectPlatform } from "./wide-events/environment.ts";

const RTK_JOIN_DEFAULT_POLICY = {
	name: "default",
	timeoutMs: 30000,
	retryDelaysMs: [500, 1000, 2000, 4000],
} as const;

const RTK_JOIN_DEGRADED_NETWORK_POLICY = {
	name: "degraded-network",
	timeoutMs: 45000,
	retryDelaysMs: [1000, 2000, 4000, 8000],
} as const;

const DEGRADED_EFFECTIVE_TYPES = new Set(["slow-2g", "2g", "3g"]);

function getBrowserNetworkHints() {
	if (typeof navigator === "undefined") {
		return undefined;
	}

	const nav = navigator as Navigator & {
		connection?: {
			effectiveType?: string;
			saveData?: boolean;
		};
	};

	return {
		effectiveType: nav.connection?.effectiveType,
		saveData: nav.connection?.saveData,
	};
}

export function getRtkJoinPolicyForCurrentCohort() {
	const platform = detectPlatform();
	const network = platform === "browser" ? getBrowserNetworkHints() : undefined;

	const effectiveType = network?.effectiveType;
	const saveData = network?.saveData === true;
	const isDegradedNetwork =
		platform === "browser" &&
		(saveData || (effectiveType ? DEGRADED_EFFECTIVE_TYPES.has(effectiveType) : false));

	const policy = isDegradedNetwork
		? RTK_JOIN_DEGRADED_NETWORK_POLICY
		: RTK_JOIN_DEFAULT_POLICY;

	const cohort =
		platform === "browser"
			? `browser-${effectiveType ?? "unknown"}${saveData ? "-save-data" : ""}`
			: `${platform}-default`;

	return {
		cohort,
		platform,
		network,
		policy: {
			name: policy.name,
			timeoutMs: policy.timeoutMs,
			retryDelaysMs: [...policy.retryDelaysMs],
		},
	};
}
