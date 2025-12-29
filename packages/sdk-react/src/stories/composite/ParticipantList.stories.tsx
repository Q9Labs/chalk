import type { Meta, StoryObj } from '@storybook/react';
import { ParticipantList } from '../../components/composite/ParticipantList';

const meta: Meta<typeof ParticipantList> = {
  title: 'Composite/ParticipantList',
  component: ParticipantList,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof ParticipantList>;

const participants = [
  { id: '1', displayName: 'John Doe', role: 'host', isMuted: false, isVideoEnabled: true },
  { id: '2', displayName: 'Jane Smith', role: 'participant', isMuted: true, isVideoEnabled: true },
  { id: '3', displayName: 'Bob Johnson', role: 'participant', isMuted: false, isVideoEnabled: false },
  { id: '4', displayName: 'Alice Williams', role: 'participant', isMuted: true, isVideoEnabled: false },
];

export const Default: Story = {
  args: {
    participants,
    searchable: true,
  },
};

export const HostView: Story = {
  args: {
    participants,
    canManageParticipants: true,
    searchable: true,
  },
};
