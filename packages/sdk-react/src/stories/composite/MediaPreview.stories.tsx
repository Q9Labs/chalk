import type { Meta, StoryObj } from '@storybook/react';
import { MediaPreview } from '../../components/composite/MediaPreview';

const meta: Meta<typeof MediaPreview> = {
  title: 'Composite/MediaPreview',
  component: MediaPreview,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof MediaPreview>;

export const Default: Story = {
  args: {
    userName: 'John Doe',
    isVideoEnabled: true,
    isAudioEnabled: true,
    audioLevel: 30,
  },
};

export const VideoDisabled: Story = {
  args: {
    userName: 'John Doe',
    isVideoEnabled: false,
    isAudioEnabled: true,
    audioLevel: 10,
  },
};
