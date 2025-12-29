import type { Meta, StoryObj } from '@storybook/react';
import { TranscriptionPanel } from '../../components/composite/TranscriptionPanel';

const meta: Meta<typeof TranscriptionPanel> = {
  title: 'Composite/TranscriptionPanel',
  component: TranscriptionPanel,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof TranscriptionPanel>;

const transcripts = [
  { id: '1', speaker: 'John Doe', text: 'Welcome to the presentation.', timestamp: new Date() },
  { id: '2', speaker: 'Jane Smith', text: 'Thank you for having us.', timestamp: new Date() },
  { id: '3', speaker: 'John Doe', text: 'Today we will discuss the new roadmap.', timestamp: new Date() },
];

export const Live: Story = {
  args: {
    transcripts,
    isLive: true,
    showSpeakerNames: true,
    showTimestamps: true,
  },
};

export const Exportable: Story = {
  args: {
    transcripts,
    isLive: false,
    onExport: (format) => console.log('Exporting as:', format),
  },
};
