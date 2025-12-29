import { describe, it, expect, vi } from 'bun:test';
import { render } from '@testing-library/react';
import { NotificationStack } from '../../components/composite/NotificationStack';

describe('NotificationStack', () => {
  const notifications = [
    { id: '1', message: 'Hello', type: 'info' as const },
    { id: '2', message: 'World', type: 'success' as const },
  ];

  it('renders all notifications', () => {
    const { getByText } = render(
      <NotificationStack notifications={notifications} onDismiss={() => {}} />
    );
    expect(getByText('Hello')).toBeDefined();
    expect(getByText('World')).toBeDefined();
  });

  it('limits visible notifications', () => {
    const manyNotifications = Array.from({ length: 10 }, (_, i) => ({
      id: `${i}`,
      message: `Note ${i}`
    }));
    const { queryByText } = render(
      <NotificationStack notifications={manyNotifications} onDismiss={() => {}} maxVisible={3} />
    );
    expect(queryByText('Note 0')).toBeDefined();
    expect(queryByText('Note 1')).toBeDefined();
    expect(queryByText('Note 2')).toBeDefined();
    expect(queryByText('Note 3')).toBeNull();
  });
});
