import type { Meta, StoryObj } from '@storybook/react';
import { SettingsPanel } from '../../components/composite/SettingsPanel';

const meta: Meta<typeof SettingsPanel> = {
  title: 'Composite/SettingsPanel',
  component: SettingsPanel,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof SettingsPanel>;

const audioDevices = [
  { deviceId: 'default', label: 'Default Microphone', kind: 'audioinput' } as MediaDeviceInfo,
  { deviceId: 'mic1', label: 'External Mic (USB)', kind: 'audioinput' } as MediaDeviceInfo,
];

const videoDevices = [
  { deviceId: 'cam1', label: 'FaceTime HD Camera', kind: 'videoinput' } as MediaDeviceInfo,
  { deviceId: 'cam2', label: 'Logitech Webcam', kind: 'videoinput' } as MediaDeviceInfo,
];

export const Default: Story = {
  args: {
    audioInputDevices: audioDevices,
    audioOutputDevices: [],
    videoInputDevices: videoDevices,
    selectedAudioInput: 'default',
    selectedVideoInput: 'cam1',
    audioLevel: 45,
  },
};
