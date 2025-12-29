import type { Meta, StoryObj } from '@storybook/react';
import { PinnedMessageBanner } from '../../components/composite/PinnedMessageBanner';

const meta: Meta<typeof PinnedMessageBanner> = {
  title: 'Composite/PinnedMessageBanner',
  component: PinnedMessageBanner,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof PinnedMessageBanner>;

export const Default: Story = {
  args: {
    message: {
      content: 'Important: The final exam will be next Tuesday at 10 AM.',
      senderName: 'Professor Higgins',
      timestamp: new Date(),
    },
    onUnpin: () => console.log('Unpinned'),
    onJumpToMessage: () => console.log('Jump to message'),
  },
};
