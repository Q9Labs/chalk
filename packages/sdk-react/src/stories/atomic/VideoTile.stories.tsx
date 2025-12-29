import type { Meta, StoryObj } from '@storybook/react';
import { VideoTile } from '../../components/atomic/VideoTile';

const meta: Meta<typeof VideoTile> = {
  title: 'Atomic/VideoTile',
  component: VideoTile,
  tags: ['autodocs'],
  argTypes: {
    participant: { control: 'object' },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg', 'xl', 'full'],
    },
    variant: {
      control: 'select',
      options: ['default', 'compact', 'minimal'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof VideoTile>;

export const Default: Story = {
  args: {
    participant: {
      id: '1',
      displayName: 'Jane Doe',
      isVideoEnabled: true,
      isAudioEnabled: true,
      isSpeaking: false,
    },
    size: 'md',
  },
};

export const Speaking: Story = {
  args: {
    participant: {
      id: '1',
      displayName: 'Jane Doe',
      isVideoEnabled: true,
      isAudioEnabled: true,
      isSpeaking: true,
    },
    size: 'md',
  },
};

export const Muted: Story = {
  args: {
    participant: {
      id: '1',
      displayName: 'Jane Doe',
      isVideoEnabled: true,
      isAudioEnabled: false,
      isMuted: true,
    },
    size: 'md',
  },
};

export const VideoDisabled: Story = {
  args: {
    participant: {
      id: '1',
      displayName: 'Jane Doe',
      isVideoEnabled: false,
      isAudioEnabled: true,
    },
    size: 'md',
  },
};
