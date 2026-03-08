import { afterEach, describe, it, expect, vi } from 'bun:test';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { ControlBar } from '../../components/composite/ControlBar';

const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices;

describe('ControlBar', () => {
  afterEach(() => {
    navigator.mediaDevices.enumerateDevices = originalEnumerateDevices;
  });

  it('renders all default buttons', () => {
    const { getByLabelText } = render(<ControlBar />);
    expect(getByLabelText('Mute')).toBeDefined();
    expect(getByLabelText('Stop Video')).toBeDefined();
    expect(getByLabelText('Share Screen')).toBeDefined();
    expect(getByLabelText('Leave')).toBeDefined();
  });

  it('calls onToggleMute when mic button is clicked', () => {
    const onToggleMute = vi.fn();
    const { getByLabelText } = render(<ControlBar onToggleMute={onToggleMute} />);
    fireEvent.click(getByLabelText('Mute'));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it('shows active state for recording', () => {
    const { getByLabelText } = render(<ControlBar isRecording={true} buttons={['record']} />);
    expect(getByLabelText('Stop Recording')).toBeDefined();
  });

  it('renders only specified buttons', () => {
    const { getByLabelText, queryByLabelText } = render(
      <ControlBar buttons={['mic', 'leave']} />
    );
    expect(getByLabelText('Mute')).toBeDefined();
    expect(getByLabelText('Leave')).toBeDefined();
    expect(queryByLabelText('Stop Video')).toBeNull();
  });

  it('renders dock device pickers and elevated settings/reactions controls', () => {
    const { getByText, getByLabelText } = render(
      <ControlBar
        variant="dock"
        audioInputDevices={[{ deviceId: 'mic-1', kind: 'audioinput', label: 'Microphone 1' }]}
        audioOutputDevices={[{ deviceId: 'spk-1', kind: 'audiooutput', label: 'Speaker 1' }]}
        videoInputDevices={[{ deviceId: 'cam-1', kind: 'videoinput', label: 'Camera 1' }]}
        selectedAudioInput="mic-1"
        selectedAudioOutput="spk-1"
        selectedVideoInput="cam-1"
        onAudioInputChange={() => {}}
        onAudioOutputChange={() => {}}
        onVideoInputChange={() => {}}
      />
    );

    expect(getByText('Microphone 1')).toBeDefined();
    expect(getByText('Speaker 1')).toBeDefined();
    expect(getByText('Camera 1')).toBeDefined();
    expect(getByLabelText('Settings').className).toContain('shadow-md');
    expect(getByLabelText('Reactions').className).toContain('shadow-md');
  });

  it('hydrates dock device pickers from browser enumeration when props are empty', async () => {
    navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Desk Mic' },
      { deviceId: 'spk-1', kind: 'audiooutput', label: 'Desk Speakers' },
      { deviceId: 'cam-1', kind: 'videoinput', label: 'Desk Cam' },
    ] as MediaDeviceInfo[]);

    const { getByText } = render(
      <ControlBar
        variant="dock"
        selectedAudioInput="mic-1"
        selectedAudioOutput="spk-1"
        selectedVideoInput="cam-1"
        onAudioInputChange={() => {}}
        onAudioOutputChange={() => {}}
        onVideoInputChange={() => {}}
      />
    );

    await waitFor(() => {
      expect(getByText('Desk Mic')).toBeDefined();
      expect(getByText('Desk Speakers')).toBeDefined();
      expect(getByText('Desk Cam')).toBeDefined();
    });
  });

  it('renders picture in picture button only when a handler is provided', () => {
    const onTogglePictureInPicture = vi.fn();
    const withHandler = render(
      <ControlBar
        buttons={['pip']}
        onTogglePictureInPicture={() => {
          void onTogglePictureInPicture();
        }}
      />
    );

    fireEvent.click(withHandler.getByLabelText('Open picture in picture'));
    expect(onTogglePictureInPicture).toHaveBeenCalledTimes(1);

    withHandler.unmount();
    const withoutHandler = render(<ControlBar buttons={['pip']} />);
    expect(withoutHandler.queryByLabelText('Open picture in picture')).toBeNull();
  });
});
