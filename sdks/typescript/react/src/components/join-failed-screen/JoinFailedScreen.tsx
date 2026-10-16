import { ClassicJoinFailedScreen } from "./ClassicJoinFailedScreen";

export interface JoinFailedScreenProps {
  readonly title?: string;
  readonly message: string;
  readonly supportCode?: string;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  readonly className?: string;
}

export function JoinFailedScreen(props: JoinFailedScreenProps): React.JSX.Element {
  return <ClassicJoinFailedScreen {...props} />;
}
