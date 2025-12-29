import type { Meta, StoryObj } from '@storybook/react';
import { VideoGrid } from '../../components/composite/VideoGrid';

const meta: Meta<typeof VideoGrid> = {
  title: 'Composite/VideoGrid',
  component: VideoGrid,
  tags: ['autodocs'],
  argTypes: {
    layout: {
      control: 'select',
      options: ['grid', 'spotlight', 'sidebar'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof VideoGrid>;

const participants = [
  { id: '1', displayName: 'John Doe', isVideoEnabled: true, isAudioEnabled: true, isSpeaking: true },
  { id: '2', displayName: 'Jane Smith', isVideoEnabled: true, isAudioEnabled: true },
  { id: '3', displayName: 'Bob Johnson', isVideoEnabled: false, isAudioEnabled: false, isMuted: true },
  { id: '4', displayName: 'Alice Williams', isVideoEnabled: true, isAudioEnabled: true },
  { id: '5', displayName: 'Charlie Brown', isVideoEnabled: true, isAudioEnabled: true },
  { id: '6', displayName: 'David Wilson', isVideoEnabled: false, isAudioEnabled: true },
];

export const Grid: Story = {
  args: {
    participants,
    layout: 'grid',
  },
};

export const Spotlight: Story = {
  args: {
    participants,
    layout: 'spotlight',
    pinnedParticipantId: '1',
  },
};

export const Sidebar: Story = {
  args: {
    participants,
    layout: 'sidebar',
    pinnedParticipantId: '1',
  },
};
