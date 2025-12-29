import type { Meta, StoryObj } from '@storybook/react';
import { TranscriptLine } from '../../components/atomic/TranscriptLine';

const meta: Meta<typeof TranscriptLine> = {
  title: 'Atomic/TranscriptLine',
  component: TranscriptLine,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof TranscriptLine>;

export const Default: Story = {
  args: {
    speaker: 'John Doe',
    speakerId: '1',
    text: 'Hello, this is a live transcription of what I am saying right now.',
    timestamp: new Date(),
    showTimestamp: true,
    showSpeaker: true,
    speakerColor: 'var(--chalk-accent)',
  },
};

export const Interim: Story = {
  args: {
    speaker: 'Jane Smith',
    speakerId: '2',
    text: 'I am thinking about...',
    timestamp: new Date(),
    isInterim: true,
    showSpeaker: true,
  },
};
