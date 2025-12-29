import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { DeviceSelector } from '../../components/composite/DeviceSelector';

describe('DeviceSelector', () => {
  const devices: MediaDeviceInfo[] = [
    { deviceId: '1', kind: 'audioinput', label: 'Mic 1', groupId: 'g1', toJSON: () => ({}) },
    { deviceId: '2', kind: 'audioinput', label: 'Mic 2', groupId: 'g2', toJSON: () => ({}) },
  ];

  it('renders device options', () => {
    const { getByText } = render(
      <DeviceSelector type="audioinput" devices={devices} onChange={() => {}} />
    );
    expect(getByText('Mic 1')).toBeDefined();
  });

  it('calls onChange when device is selected', () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <DeviceSelector type="audioinput" devices={devices} onChange={onChange} />
    );
    const select = getByRole('combobox');
    fireEvent.change(select, { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith('2');
  });

  it('shows audio indicator for audio input', () => {
    const { getByRole } = render(
      <DeviceSelector type="audioinput" devices={devices} onChange={() => {}} />
    );
    expect(getByRole('status')).toBeDefined();
  });
});
