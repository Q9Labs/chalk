import type { Meta, StoryObj } from '@storybook/react';
import { WaitingRoom } from '../../components/composite/WaitingRoom';

const meta: Meta<typeof WaitingRoom> = {
  title: 'Composite/WaitingRoom',
  component: WaitingRoom,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof WaitingRoom>;

const participants = [
  { id: '1', displayName: 'John Doe', requestedAt: new Date() },
  { id: '2', displayName: 'Jane Smith', requestedAt: new Date() },
];

export const Default: Story = {
  args: {
    participants,
    onAdmit: (id) => console.log('Admitted:', id),
    onDeny: (id) => console.log('Denied:', id),
  },
};
