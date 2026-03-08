import { afterEach, describe, it, expect, vi } from 'bun:test';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { DeviceSelector } from '../../components/composite/DeviceSelector';

describe('DeviceSelector', () => {
  const devices: MediaDeviceInfo[] = [
    { deviceId: '1', kind: 'audioinput', label: 'Mic 1', groupId: 'g1', toJSON: () => ({}) },
    { deviceId: '2', kind: 'audioinput', label: 'Mic 2', groupId: 'g2', toJSON: () => ({}) },
  ];

  it('renders device options', () => {
    const { getByRole, getByText } = render(
      <DeviceSelector type="audioinput" devices={devices} onChange={() => {}} />
    );
    fireEvent.click(getByRole('button', { name: 'Select device' }));
    expect(getByText('Mic 1')).toBeDefined();
  });

  it('calls onChange when device is selected', () => {
    const onChange = vi.fn();
    const { getByRole, getByText } = render(
      <DeviceSelector type="audioinput" devices={devices} onChange={onChange} />
    );
    fireEvent.click(getByRole('button', { name: 'Select device' }));
    fireEvent.click(getByText('Mic 2'));
    expect(onChange).toHaveBeenCalledWith('2');
  });

  it('shows audio indicator for audio input', () => {
    const { getByRole } = render(
      <DeviceSelector type="audioinput" devices={devices} onChange={() => {}} />
    );
    expect(getByRole('status')).toBeDefined();
  });

  afterEach(() => {
    delete (window.HTMLMediaElement.prototype as HTMLMediaElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    }).setSinkId;
  });

  it('plays a routed test tone for audio output', async () => {
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      value: setSinkId,
    });

    const { container, getByLabelText } = render(
      <DeviceSelector
        type="audiooutput"
        devices={[
          { deviceId: 'spk-1', kind: 'audiooutput', label: 'Speaker 1', groupId: 'g1', toJSON: () => ({}) },
        ]}
        selectedDeviceId="spk-1"
        onChange={() => {}}
      />
    );

    fireEvent.click(getByLabelText('Test speakers'));

    await waitFor(() => {
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(setSinkId).toHaveBeenCalledWith('spk-1');
    });
    expect(container.querySelector('audio')?.getAttribute('src')).toContain('data:audio/wav;base64,');
  });
});
