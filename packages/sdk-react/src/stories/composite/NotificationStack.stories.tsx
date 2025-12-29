import type { Meta, StoryObj } from '@storybook/react';
import { NotificationStack } from '../../components/composite/NotificationStack';

const meta: Meta<typeof NotificationStack> = {
  title: 'Composite/NotificationStack',
  component: NotificationStack,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof NotificationStack>;

const notifications = [
  { id: '1', message: 'John Doe joined the meeting', type: 'info' as const, timestamp: new Date() },
  { id: '2', message: 'Recording started', type: 'success' as const, timestamp: new Date() },
  { id: '3', message: 'Connection unstable', type: 'warning' as const, timestamp: new Date() },
];

export const Default: Story = {
  args: {
    notifications,
    position: 'top-right',
    maxVisible: 5,
  },
};
