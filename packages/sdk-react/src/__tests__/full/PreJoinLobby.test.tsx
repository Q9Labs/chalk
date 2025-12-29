import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { PreJoinLobby } from '../../components/full/PreJoinLobby';

// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
global.MediaStream = vi.fn().mockImplementation(() => ({})) as any;

describe('PreJoinLobby', () => {
  it('renders correctly', () => {
    const { getByText, getByPlaceholderText } = render(
      <PreJoinLobby onJoin={() => {}} roomName="Big Meeting" />
    );
    expect(getByText('Big Meeting')).toBeDefined();
    expect(getByPlaceholderText('Enter your name')).toBeDefined();
    expect(getByText('Join Meeting')).toBeDefined();
  });

  it('calls onJoin with settings when join button is clicked', () => {
    const onJoin = vi.fn();
    const { getByPlaceholderText, getByText } = render(
      <PreJoinLobby onJoin={onJoin} />
    );
    
    const input = getByPlaceholderText('Enter your name');
    fireEvent.change(input, { target: { value: 'John Doe' } });
    
    fireEvent.click(getByText('Join Meeting'));
    expect(onJoin).toHaveBeenCalled();
    expect(onJoin.mock.calls[0][0].displayName).toBe('John Doe');
  });

  it('shows error toast when error prop is provided', () => {
    const { getByText } = render(
      <PreJoinLobby onJoin={() => {}} error="Failed to get camera" />
    );
    expect(getByText('Failed to get camera')).toBeDefined();
  });
});
