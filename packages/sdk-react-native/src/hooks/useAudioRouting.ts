import { useCallback, useEffect, useState } from "react";
import { NativeModules, Platform } from "react-native";

export type AudioRoute = "speaker" | "earpiece" | "bluetooth" | "headphones";

export interface UseAudioRoutingResult {
	currentRoute: AudioRoute;
	availableRoutes: AudioRoute[];
	setRoute: (route: AudioRoute) => Promise<void>;
	isSpeakerOn: boolean;
	toggleSpeaker: () => Promise<void>;
}

interface AudioSessionModule {
	setOutputRoute: (route: AudioRoute) => Promise<void>;
	getAvailableRoutes?: () => Promise<AudioRoute[]>;
	getCurrentRoute?: () => Promise<AudioRoute>;
}

function getAudioSessionModule(): AudioSessionModule | null {
	return (NativeModules.AudioSessionModule as AudioSessionModule) ?? null;
}

export function useAudioRouting(): UseAudioRoutingResult {
	const [currentRoute, setCurrentRoute] = useState<AudioRoute>("speaker");
	const [availableRoutes, setAvailableRoutes] = useState<AudioRoute[]>([
		"speaker",
		"earpiece",
	]);

	useEffect(() => {
		const audioModule = getAudioSessionModule();

		async function detectAvailableRoutes(): Promise<void> {
			if (audioModule?.getAvailableRoutes) {
				try {
					const routes = await audioModule.getAvailableRoutes();
					setAvailableRoutes(routes);
				} catch {
					setAvailableRoutes(["speaker", "earpiece"]);
				}
			} else if (Platform.OS === "ios") {
				setAvailableRoutes(["speaker", "earpiece"]);
			} else {
				setAvailableRoutes(["speaker", "earpiece"]);
			}
		}

		async function detectCurrentRoute(): Promise<void> {
			if (audioModule?.getCurrentRoute) {
				try {
					const route = await audioModule.getCurrentRoute();
					setCurrentRoute(route);
				} catch {
					setCurrentRoute("speaker");
				}
			}
		}

		detectAvailableRoutes();
		detectCurrentRoute();
	}, []);

	const setRoute = useCallback(async (route: AudioRoute): Promise<void> => {
		const audioModule = getAudioSessionModule();

		try {
			if (audioModule?.setOutputRoute) {
				await audioModule.setOutputRoute(route);
			}
			setCurrentRoute(route);
		} catch (error) {
			console.error("[useAudioRouting] Failed to set route:", error);
		}
	}, []);

	const toggleSpeaker = useCallback(async (): Promise<void> => {
		const newRoute = currentRoute === "speaker" ? "earpiece" : "speaker";
		await setRoute(newRoute);
	}, [currentRoute, setRoute]);

	return {
		currentRoute,
		availableRoutes,
		setRoute,
		isSpeakerOn: currentRoute === "speaker",
		toggleSpeaker,
	};
}
