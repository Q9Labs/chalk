import { lazy, Suspense, type ComponentType } from "react";
import { Spinner } from "@q9labsai/chalk-ui";

export const LazyChatPanel = lazy(() => import("./composite/ChatPanel").then((m) => ({ default: m.ChatPanel })));

export function withSuspense<P extends object>(LazyComponent: ComponentType<P>, fallback?: React.ReactNode) {
  return function SuspenseWrapper(props: P) {
    return (
      <Suspense fallback={fallback || <Spinner size="md" />}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}

export const SuspenseChatPanel = withSuspense(LazyChatPanel);
