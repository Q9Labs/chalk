declare module "@cloudflare/realtimekit-react" {
	import type { ReactNode, ComponentType } from "react";

	export interface RealtimeKitProviderProps {
		value: unknown;
		children: ReactNode;
	}

	export const RealtimeKitProvider: ComponentType<RealtimeKitProviderProps>;

	export function useRealtimeKitClient(): unknown;
	export function useLocalMedia(): {
		audioTrack: MediaStreamTrack | undefined;
		videoTrack: MediaStreamTrack | undefined;
	};
	export function useRemoteMedia(participantId: string): {
		audioTrack: MediaStreamTrack | undefined;
		videoTrack: MediaStreamTrack | undefined;
	};
}
