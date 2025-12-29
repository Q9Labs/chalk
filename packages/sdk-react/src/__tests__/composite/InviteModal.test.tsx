import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { InviteModal } from '../../components/composite/InviteModal';

describe('InviteModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    meetingLink: 'https://chalk.com/m/123',
  };

  it('renders correctly when open', () => {
    const { getByText, getByDisplayValue } = render(<InviteModal {...defaultProps} />);
    expect(getByText('Invite Participants')).toBeDefined();
    expect(getByDisplayValue(defaultProps.meetingLink)).toBeDefined();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(<InviteModal {...defaultProps} onClose={onClose} />);
    fireEvent.click(getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onCopyLink when copy button is clicked', () => {
    const onCopyLink = vi.fn();
    const { getByText } = render(<InviteModal {...defaultProps} onCopyLink={onCopyLink} />);
    fireEvent.click(getByText('Copy Link'));
    expect(onCopyLink).toHaveBeenCalledTimes(1);
  });

  it('returns null when closed', () => {
    const { container } = render(<InviteModal {...defaultProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });
});
