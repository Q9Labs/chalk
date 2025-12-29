import type { Meta, StoryObj } from '@storybook/react';
import { PreJoinLobby } from '../../components/full/PreJoinLobby';

const meta: Meta<typeof PreJoinLobby> = {
  title: 'Full/PreJoinLobby',
  component: PreJoinLobby,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof PreJoinLobby>;

export const Default: Story = {
  args: {
    roomName: 'Physics 101: Gravity',
    userName: 'Student User',
    onJoin: (settings) => console.log('Joining with settings:', settings),
  },
};
