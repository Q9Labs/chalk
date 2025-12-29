import type { Meta, StoryObj } from '@storybook/react';
import { MessageBubble } from '../../components/composite/MessageBubble';

const meta: Meta<typeof MessageBubble> = {
  title: 'Composite/MessageBubble',
  component: MessageBubble,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof MessageBubble>;

export const Local: Story = {
  args: {
    content: 'Hello! This is a message from me.',
    senderName: 'Jane Smith',
    timestamp: new Date(),
    isLocal: true,
  },
};

export const Remote: Story = {
  args: {
    content: 'Hi Jane, good to see you here.',
    senderName: 'John Doe',
    timestamp: new Date(),
    isLocal: false,
    showSender: true,
    showTimestamp: true,
  },
};

export const System: Story = {
  args: {
    content: 'John Doe has joined the meeting',
    senderName: 'System',
    timestamp: new Date(),
    isSystem: true,
  },
};
