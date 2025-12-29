import type { Meta, StoryObj } from '@storybook/react';
import { MobileControlSheet } from '../../components/composite/MobileControlSheet';

const meta: Meta<typeof MobileControlSheet> = {
  title: 'Composite/MobileControlSheet',
  component: MobileControlSheet,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof MobileControlSheet>;

export const Default: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    isMuted: false,
    isVideoEnabled: true,
    isScreenSharing: false,
    isRecording: false,
    isChatOpen: false,
    isParticipantsOpen: false,
  },
};
