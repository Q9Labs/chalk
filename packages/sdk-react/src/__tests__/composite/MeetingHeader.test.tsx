import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { MeetingHeader } from '../../components/composite/MeetingHeader';

describe('MeetingHeader', () => {
  const defaultProps = {
    roomName: 'General Class',
  };

  it('renders room name correctly', () => {
    const { getByText } = render(<MeetingHeader {...defaultProps} />);
    expect(getByText('General Class')).toBeDefined();
  });

  it('formats and displays duration', () => {
    const { getByText } = render(<MeetingHeader {...defaultProps} duration={3661} />);
    expect(getByText('1:01:01')).toBeDefined();
  });

  it('calls onInvite when invite button is clicked', () => {
    const onInvite = vi.fn();
    const { getByLabelText } = render(<MeetingHeader {...defaultProps} onInvite={onInvite} />);
    fireEvent.click(getByLabelText('Invite participants'));
    expect(onInvite).toHaveBeenCalledTimes(1);
  });

  it('displays status badges when active', () => {
    const { getByLabelText } = render(
      <MeetingHeader {...defaultProps} isRecording={true} isTranscribing={true} />
    );
    expect(getByLabelText('recording')).toBeDefined();
    expect(getByLabelText('transcribing')).toBeDefined();
  });

  it('calls onLayoutChange when layout button is clicked', () => {
    const onLayoutChange = vi.fn();
    const { getByLabelText } = render(
      <MeetingHeader {...defaultProps} onLayoutChange={onLayoutChange} />
    );
    fireEvent.click(getByLabelText('Grid layout'));
    expect(onLayoutChange).toHaveBeenCalledWith('grid');
  });
});
