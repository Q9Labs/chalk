import { useLocalSearchParams, Stack } from 'expo-router';
import PreCallFlow from './tests/pre-call';
import FullCallFlow from './tests/full-call';

const FLOW_TITLES: Record<string, string> = {
  'pre-call': 'Pre-call Flow',
  'full-call': 'Full Call Flow',
};

const FLOW_SCREENS: Record<string, React.ComponentType> = {
  'pre-call': PreCallFlow,
  'full-call': FullCallFlow,
};

export default function FlowScreen() {
  const { flow } = useLocalSearchParams<{ flow: string }>();
  const title = FLOW_TITLES[flow ?? ''] ?? 'Unknown Flow';
  const FlowComponent = FLOW_SCREENS[flow ?? ''];

  return (
    <>
      <Stack.Screen options={{ title }} />
      {FlowComponent ? <FlowComponent /> : null}
    </>
  );
}
