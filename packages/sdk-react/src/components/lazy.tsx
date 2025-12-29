import { lazy, Suspense, type ComponentType } from 'react';
import { Spinner } from './atomic/Spinner';

export const LazyChatPanel = lazy(() => import('./composite/ChatPanel').then(m => ({ default: m.ChatPanel })));
export const LazyTranscriptionPanel = lazy(() => import('./composite/TranscriptionPanel').then(m => ({ default: m.TranscriptionPanel })));
export const LazySettingsPanel = lazy(() => import('./composite/SettingsPanel').then(m => ({ default: m.SettingsPanel })));
export const LazyBackgroundEffectsPicker = lazy(() => import('./composite/BackgroundEffectsPicker').then(m => ({ default: m.BackgroundEffectsPicker })));

export function withSuspense<P extends object>(
  LazyComponent: ComponentType<P>,
  fallback?: React.ReactNode
) {
  return function SuspenseWrapper(props: P) {
    return (
      <Suspense fallback={fallback || <Spinner size="md" />}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}

export const SuspenseChatPanel = withSuspense(LazyChatPanel);
export const SuspenseTranscriptionPanel = withSuspense(LazyTranscriptionPanel);
export const SuspenseSettingsPanel = withSuspense(LazySettingsPanel);
export const SuspenseBackgroundEffectsPicker = withSuspense(LazyBackgroundEffectsPicker);
