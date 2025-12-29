import type { Meta, StoryObj } from '@storybook/react';
import { MeetingHeader } from '../../components/composite/MeetingHeader';

const meta: Meta<typeof MeetingHeader> = {
  title: 'Composite/MeetingHeader',
  component: MeetingHeader,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof MeetingHeader>;

export const Default: Story = {
  args: {
    roomName: 'Introduction to Advanced Physics',
    duration: 1805,
    isRecording: true,
    isTranscribing: true,
  },
};
