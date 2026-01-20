import { Stack, useLocalSearchParams } from "expo-router";
import AudioRoutingTest from "./tests/audio-routing";
import CallKitTest from "./tests/call-kit";
import ChatTest from "./tests/chat";
import DevicesTest from "./tests/devices";
import ForegroundServiceTest from "./tests/foreground-service";
import HandRaiseTest from "./tests/hand-raise";
import InteractionsTest from "./tests/interactions";
import LocalStreamTest from "./tests/local-stream";
import MediaTest from "./tests/media";
import ParticipantsTest from "./tests/participants";
import PermissionsTest from "./tests/permissions";
import RecordingTest from "./tests/recording";
import RoomTest from "./tests/room";
import ScreenShareTest from "./tests/screen-share";

const HOOK_TITLES: Record<string, string> = {
	room: "useRoom",
	media: "useMedia",
	participants: "useParticipants",
	devices: "useDevices",
	permissions: "usePermissions",
	chat: "useChat",
	recording: "useRecording",
	"screen-share": "useScreenShare",
	"audio-routing": "useAudioRouting",
	"call-kit": "useCallKit",
	"foreground-service": "useForegroundService",
	interactions: "useInteractions",
	"hand-raise": "useHandRaise",
	"local-stream": "useLocalStream",
};

const HOOK_COMPONENTS: Record<string, React.ComponentType> = {
	room: RoomTest,
	media: MediaTest,
	participants: ParticipantsTest,
	devices: DevicesTest,
	permissions: PermissionsTest,
	chat: ChatTest,
	recording: RecordingTest,
	"screen-share": ScreenShareTest,
	"audio-routing": AudioRoutingTest,
	"call-kit": CallKitTest,
	"foreground-service": ForegroundServiceTest,
	interactions: InteractionsTest,
	"hand-raise": HandRaiseTest,
	"local-stream": LocalStreamTest,
};

export default function HookScreen() {
	const { hook } = useLocalSearchParams<{ hook: string }>();
	const title = HOOK_TITLES[hook ?? ""] ?? "Unknown Hook";
	const TestComponent = HOOK_COMPONENTS[hook ?? ""];

	return (
		<>
			<Stack.Screen options={{ title }} />
			{TestComponent ? <TestComponent /> : null}
		</>
	);
}
