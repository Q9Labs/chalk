import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { PinnedMessageBanner } from '../../components/composite/PinnedMessageBanner';

describe('PinnedMessageBanner', () => {
  const message = {
    content: 'Important info',
    senderName: 'Alice',
    timestamp: new Date(),
  };

  it('renders correctly', () => {
    const { getByText } = render(<PinnedMessageBanner message={message} />);
    expect(getByText('Pinned Message')).toBeDefined();
    expect(getByText(/Alice:/)).toBeDefined();
    expect(getByText(/Important info/)).toBeDefined();
  });

  it('calls onUnpin when unpin button clicked', () => {
    const onUnpin = vi.fn();
    const { getByLabelText } = render(
      <PinnedMessageBanner message={message} onUnpin={onUnpin} />
    );
    fireEvent.click(getByLabelText('Unpin message'));
    expect(onUnpin).toHaveBeenCalledTimes(1);
  });

  it('calls onJumpToMessage when content clicked', () => {
    const onJumpToMessage = vi.fn();
    const { getByRole } = render(
      <PinnedMessageBanner message={message} onJumpToMessage={onJumpToMessage} />
    );
    fireEvent.click(getByRole('button'));
    expect(onJumpToMessage).toHaveBeenCalledTimes(1);
  });
});
