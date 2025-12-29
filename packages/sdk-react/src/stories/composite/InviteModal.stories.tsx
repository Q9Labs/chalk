import type { Meta, StoryObj } from '@storybook/react';
import { InviteModal } from '../../components/composite/InviteModal';

const meta: Meta<typeof InviteModal> = {
  title: 'Composite/InviteModal',
  component: InviteModal,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof InviteModal>;

export const Default: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    meetingLink: 'https://chalk.live/room_123',
    meetingId: 'room_123',
  },
};
