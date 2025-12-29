import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
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

  it('handles feedback submission', () => {
    const onSubmitFeedback = vi.fn();
    const { getByLabelText, getByText, getByPlaceholderText } = render(
      <EndScreen {...defaultProps} onSubmitFeedback={onSubmitFeedback} />
    );
    
    fireEvent.click(getByLabelText('Rate 5 stars'));
    const commentArea = getByPlaceholderText('Any comments or issues?');
    fireEvent.change(commentArea, { target: { value: 'Great class!' } });
    
    fireEvent.click(getByText('Submit Feedback'));
    expect(onSubmitFeedback).toHaveBeenCalledWith(5, 'Great class!');
    expect(getByText('Thank you for your feedback!')).toBeDefined();
  });

  it('calls onRejoin when rejoin button clicked', () => {
    const onRejoin = vi.fn();
    const { getByText } = render(<EndScreen {...defaultProps} onRejoin={onRejoin} />);
    fireEvent.click(getByText('Rejoin'));
    expect(onRejoin).toHaveBeenCalledTimes(1);
  });
});
