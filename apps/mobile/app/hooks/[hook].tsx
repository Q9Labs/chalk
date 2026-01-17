import { useLocalSearchParams, Stack } from 'expo-router';
import RoomTest from './tests/room';
import MediaTest from './tests/media';
import ParticipantsTest from './tests/participants';
import DevicesTest from './tests/devices';
import PermissionsTest from './tests/permissions';
import ChatTest from './tests/chat';
import RecordingTest from './tests/recording';
import ScreenShareTest from './tests/screen-share';
import AudioRoutingTest from './tests/audio-routing';
import CallKitTest from './tests/call-kit';
import ForegroundServiceTest from './tests/foreground-service';
import InteractionsTest from './tests/interactions';
import HandRaiseTest from './tests/hand-raise';
import LocalStreamTest from './tests/local-stream';

const HOOK_TITLES: Record<string, string> = {
  room: 'useRoom',
  media: 'useMedia',
  participants: 'useParticipants',
  devices: 'useDevices',
  permissions: 'usePermissions',
  chat: 'useChat',
  recording: 'useRecording',
  'screen-share': 'useScreenShare',
  'audio-routing': 'useAudioRouting',
  'call-kit': 'useCallKit',
  'foreground-service': 'useForegroundService',
  interactions: 'useInteractions',
  'hand-raise': 'useHandRaise',
  'local-stream': 'useLocalStream',
};

const HOOK_COMPONENTS: Record<string, React.ComponentType> = {
  room: RoomTest,
  media: MediaTest,
  participants: ParticipantsTest,
  devices: DevicesTest,
  permissions: PermissionsTest,
  chat: ChatTest,
  recording: RecordingTest,
  'screen-share': ScreenShareTest,
  'audio-routing': AudioRoutingTest,
  'call-kit': CallKitTest,
  'foreground-service': ForegroundServiceTest,
  interactions: InteractionsTest,
  'hand-raise': HandRaiseTest,
  'local-stream': LocalStreamTest,
};

export default function HookScreen() {
  const { hook } = useLocalSearchParams<{ hook: string }>();
  const title = HOOK_TITLES[hook ?? ''] ?? 'Unknown Hook';
  const TestComponent = HOOK_COMPONENTS[hook ?? ''];

  return (
    <>
      <Stack.Screen options={{ title }} />
      {TestComponent ? <TestComponent /> : null}
    </>
  );
}
