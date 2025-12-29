import type { Meta, StoryObj } from '@storybook/react';
import { ScreenShareView } from '../../components/composite/ScreenShareView';

const meta: Meta<typeof ScreenShareView> = {
  title: 'Composite/ScreenShareView',
  component: ScreenShareView,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof ScreenShareView>;

export const Default: Story = {
  args: {
    // @ts-ignore - Mocking MediaStreamTrack
    screenShareTrack: { id: 'track_1', kind: 'video', enabled: true },
    sharedByName: 'John Doe',
    participants: [
      { id: '2', displayName: 'Jane Smith', isVideoEnabled: true },
      { id: '3', displayName: 'Bob Johnson', isVideoEnabled: false },
    ],
    showThumbnails: true,
    thumbnailPosition: 'bottom',
  },
};
