import { describe, it, expect, vi } from 'bun:test';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EndScreen } from '../../components/full/EndScreen';

describe('EndScreen', () => {
  const defaultProps = {
    roomName: 'Algebra 101',
    duration: 3600,
    participantCount: 15,
  };

  it('renders correctly', () => {
    const { getByText } = render(<EndScreen {...defaultProps} />);
    expect(getByText('Meeting Ended')).toBeDefined();
    expect(getByText('Algebra 101')).toBeDefined();
    expect(getByText(/1h 0m/)).toBeDefined();
    expect(getByText('15 participants')).toBeDefined();
  });

  it('handles feedback submission', async () => {
    const onSubmitFeedback = vi.fn();
    const user = userEvent.setup();
    const { getByLabelText, getByText, getByPlaceholderText } = render(
      <EndScreen {...defaultProps} onSubmitFeedback={onSubmitFeedback} />
    );
    
    await user.click(getByLabelText('Rate 5 stars'));
    const commentArea = getByPlaceholderText('Any comments or issues?');
    await user.type(commentArea, 'Great class!');
    
    await user.click(getByText('Submit Feedback'));
    expect(onSubmitFeedback).toHaveBeenCalledWith(5, 'Great class!');
    expect(getByText('Thank you for your feedback!')).toBeDefined();
  });

  it('calls onRejoin when rejoin button clicked', () => {
    const onRejoin = vi.fn();
    const { getByText } = render(<EndScreen {...defaultProps} onRejoin={onRejoin} />);
    getByText('Rejoin').click();
    expect(onRejoin).toHaveBeenCalledTimes(1);
  });
});
