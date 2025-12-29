import type { Meta, StoryObj } from '@storybook/react';
import { RecordingControls } from '../../components/composite/RecordingControls';

const meta: Meta<typeof RecordingControls> = {
  title: 'Composite/RecordingControls',
  component: RecordingControls,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof RecordingControls>;

export const Start: Story = {
  args: {
    isRecording: false,
    canRecord: true,
  },
};

export const Recording: Story = {
  args: {
    isRecording: true,
    duration: 125,
  },
};

export const Paused: Story = {
  args: {
    isRecording: true,
    isPaused: true,
    duration: 125,
  },
};
