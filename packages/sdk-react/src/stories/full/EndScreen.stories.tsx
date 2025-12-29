import type { Meta, StoryObj } from '@storybook/react';
import { EndScreen } from '../../components/full/EndScreen';

const meta: Meta<typeof EndScreen> = {
  title: 'Full/EndScreen',
  component: EndScreen,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof EndScreen>;

export const Default: Story = {
  args: {
    roomName: 'Physics 101: Gravity',
    duration: 3605,
    participantCount: 24,
    hasRecording: true,
    hasTranscription: true,
  },
};
