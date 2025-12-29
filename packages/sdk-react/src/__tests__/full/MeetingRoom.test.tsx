import { describe, it, expect, vi, beforeAll } from 'bun:test';
import { render } from '@testing-library/react';
import { MeetingRoom } from '../../components/full/MeetingRoom';

// Mock everything
// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
// @ts-ignore
window.HTMLElement.prototype.scrollIntoView = vi.fn();
global.MediaStream = vi.fn().mockImplementation(() => ({})) as any;
global.MediaStreamTrack = vi.fn().mockImplementation(() => ({
  kind: 'video',
  enabled: true,
  stop: vi.fn(),
})) as any;

describe('MeetingRoom', () => {
  const localParticipant = {
    id: 'local',
    displayName: 'Me',
    isLocal: true,
  };

  const participants = [
    { id: 'p1', displayName: 'Alice' },
  ];

  it('renders correctly', () => {
    const { getByText, getByLabelText } = render(
      <MeetingRoom 
        roomName="Test Room" 
        localParticipant={localParticipant} 
        participants={participants} 
      />
    );
    expect(getByText('Test Room')).toBeDefined();
    expect(getByLabelText('Meeting controls')).toBeDefined();
  });

  it('shows chat panel when defaultChatOpen is true', () => {
    const { getByLabelText } = render(
      <MeetingRoom 
        roomName="Test Room" 
        localParticipant={localParticipant} 
        participants={[]} 
        defaultChatOpen={true}
      />
    );
    expect(getByLabelText('Chat panel')).toBeDefined();
  });
});
