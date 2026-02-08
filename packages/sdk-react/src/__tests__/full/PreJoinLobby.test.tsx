import { describe, it, expect, vi } from 'bun:test';
import { act, fireEvent, render } from '@testing-library/react';
import { PreJoinLobby } from '../../components/full/PreJoinLobby';

// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
global.MediaStream = vi.fn().mockImplementation(() => ({})) as any;

describe('PreJoinLobby', () => {
  it('renders correctly', async () => {
    const { getByText, getByPlaceholderText } = render(
      <PreJoinLobby
        onJoin={() => {}}
        roomName="Big Meeting"
        initialVideoEnabled={false}
        initialAudioEnabled={false}
      />
    );
    await act(async () => {});
    expect(getByText('Big Meeting')).toBeDefined();
    expect(getByPlaceholderText('Enter your name')).toBeDefined();
    expect(getByText('Ask to join')).toBeDefined();
  });

  it('calls onJoin with settings when join button is clicked', async () => {
    const onJoin = vi.fn();
    const { getByPlaceholderText, getByText } = render(
      <PreJoinLobby
        onJoin={onJoin}
        userName="John Doe"
        initialVideoEnabled={false}
        initialAudioEnabled={false}
      />
    );
    await act(async () => {});
    
    const input = getByPlaceholderText('Enter your name');
    expect((input as HTMLInputElement).value).toBe('John Doe');
    await act(async () => {
      fireEvent.click(getByText('Ask to join'));
    });
    expect(onJoin).toHaveBeenCalled();
    expect(onJoin.mock.calls[0][0].displayName).toBe('John Doe');
  });

  it('allows clearing the default Guest name', async () => {
    const { getByPlaceholderText } = render(
      <PreJoinLobby
        onJoin={() => {}}
        initialVideoEnabled={false}
        initialAudioEnabled={false}
      />
    );
    await act(async () => {});

    const input = getByPlaceholderText('Enter your name') as HTMLInputElement;
    expect(input.value).toBe('Guest');

    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
    });
    await act(async () => {});
    expect(input.value).toBe('');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Hasan' } });
    });
    await act(async () => {});
    expect(input.value).toBe('Hasan');
  });

  it('shows error toast when error prop is provided', async () => {
    const { getByText } = render(
      <PreJoinLobby
        onJoin={() => {}}
        error="Failed to get camera"
        initialVideoEnabled={false}
        initialAudioEnabled={false}
      />
    );
    await act(async () => {});
    expect(getByText('Failed to get camera')).toBeDefined();
  });
});
