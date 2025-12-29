import type { Meta, StoryObj } from '@storybook/react';
import { ChatPanel } from '../../components/composite/ChatPanel';

const meta: Meta<typeof ChatPanel> = {
  title: 'Composite/ChatPanel',
  component: ChatPanel,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof ChatPanel>;

const messages = [
  { id: '1', content: 'Hello everyone!', senderName: 'John Doe', timestamp: new Date(), isLocal: false },
  { id: '2', content: 'Hi John, how are you?', senderName: 'Jane Smith', timestamp: new Date(), isLocal: true },
  { id: '3', content: 'Great to be here!', senderName: 'Bob Johnson', timestamp: new Date(), isLocal: false },
  { id: '4', content: 'Welcome Bob!', senderName: 'John Doe', timestamp: new Date(), isLocal: false },
];

export const Default: Story = {
  args: {
    messages,
    onSendMessage: (content) => console.log('Sending message:', content),
  },
};

export const Disabled: Story = {
  args: {
    messages,
    onSendMessage: (content) => console.log('Sending message:', content),
    disabled: true,
    placeholder: 'Chat is disabled by the host',
  },
};
