import type { Meta, StoryObj } from '@storybook/react';
import { DeviceSelector } from '../../components/composite/DeviceSelector';

const meta: Meta<typeof DeviceSelector> = {
  title: 'Composite/DeviceSelector',
  component: DeviceSelector,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof DeviceSelector>;

const devices = [
  { deviceId: '1', label: 'Internal Microphone', kind: 'audioinput' } as MediaDeviceInfo,
  { deviceId: '2', label: 'USB Audio Device', kind: 'audioinput' } as MediaDeviceInfo,
];

export const AudioInput: Story = {
  args: {
    type: 'audioinput',
    devices,
    selectedDeviceId: '1',
    label: 'Microphone',
    audioLevel: 50,
  },
};

export const VideoInput: Story = {
  args: {
    type: 'videoinput',
    devices: [
      { deviceId: 'v1', label: 'FaceTime HD Camera', kind: 'videoinput' } as MediaDeviceInfo,
    ],
    selectedDeviceId: 'v1',
    label: 'Camera',
  },
};
