import { Stack, useLocalSearchParams } from "expo-router";
import AudioSessionTest from "./tests/audio-session";
import ParticipantTileTest from "./tests/participant-tile";
import ScreenShareViewTest from "./tests/screen-share-view";
import VideoGridTest from "./tests/video-grid";
import VideoViewTest from "./tests/video-view";

const COMPONENT_TITLES: Record<string, string> = {
	"video-view": "VideoView",
	"screen-share-view": "ScreenShareView",
	"participant-tile": "ParticipantTile",
	"video-grid": "VideoGrid",
	"audio-session": "AudioSession",
};

const COMPONENT_SCREENS: Record<string, React.ComponentType> = {
	"video-view": VideoViewTest,
	"screen-share-view": ScreenShareViewTest,
	"participant-tile": ParticipantTileTest,
	"video-grid": VideoGridTest,
	"audio-session": AudioSessionTest,
};

export default function ComponentScreen() {
	const { component } = useLocalSearchParams<{ component: string }>();
	const title = COMPONENT_TITLES[component ?? ""] ?? "Unknown Component";
	const TestComponent = COMPONENT_SCREENS[component ?? ""];

	return (
		<>
			<Stack.Screen options={{ title }} />
			{TestComponent ? <TestComponent /> : null}
		</>
	);
}
