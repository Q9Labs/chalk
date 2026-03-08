import { beforeEach, describe, it, expect, vi } from 'bun:test';
import { fireEvent, render } from '@testing-library/react';
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
  beforeEach(() => {
    localStorage.clear();
  });

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

  it('keeps mobile mute control clickable when invite toast is visible', () => {
    const onToggleMute = vi.fn();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 639px)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })) as any;

    try {
      const { getByLabelText, getByRole } = render(
        <MeetingRoom
          roomName="Test Room"
          localParticipant={localParticipant}
          participants={participants}
          enableTour={false}
          onToggleMute={onToggleMute}
        />
      );

      fireEvent.click(getByLabelText('Mute'));
      expect(onToggleMute).toHaveBeenCalledTimes(1);

      const inviteToast = getByRole('status');
      expect(inviteToast.className).toContain('top-4');
      expect(inviteToast.className).toContain('bottom-auto');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('shows support code in connection overlay', () => {
    const { getByText } = render(
      <MeetingRoom
        roomName="Test Room"
        localParticipant={localParticipant}
        participants={participants}
        connectionState="failed"
        connectionSupportCode="CHK-20260302-121212-001"
      />
    );

    expect(getByText('Support Code')).toBeDefined();
    expect(getByText('CHK-20260302-121212-001')).toBeDefined();
  });

  it('opens the settings dialog and changes microphone preference', () => {
    const onAudioInputChange = vi.fn();
    const { getByLabelText, getByRole, getByText } = render(
      <MeetingRoom
        roomName="Test Room"
        localParticipant={localParticipant}
        participants={participants}
        enableTour={false}
        audioInputDevices={[
          { deviceId: 'mic-1', kind: 'audioinput', label: 'Microphone 1' },
          { deviceId: 'mic-2', kind: 'audioinput', label: 'Microphone 2' },
        ]}
        audioOutputDevices={[
          { deviceId: 'spk-1', kind: 'audiooutput', label: 'Speaker 1' },
          { deviceId: 'spk-2', kind: 'audiooutput', label: 'Speaker 2' },
        ]}
        videoInputDevices={[
          { deviceId: 'cam-1', kind: 'videoinput', label: 'Camera 1' },
          { deviceId: 'cam-2', kind: 'videoinput', label: 'Camera 2' },
        ]}
        selectedAudioInput="mic-1"
        onAudioInputChange={onAudioInputChange}
      />
    );

    fireEvent.click(getByRole('button', { name: 'Settings' }));
    expect(getByLabelText('Search settings')).toBeDefined();
    fireEvent.click(getByText('Microphone 1'));
    fireEvent.click(getByText('Microphone 2'));
    expect(onAudioInputChange).toHaveBeenCalledWith('mic-2');
  });
});
