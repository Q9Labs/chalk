import type { Meta, StoryObj } from '@storybook/react';
import { ReactionBubble } from '../../components/atomic/ReactionBubble';

const meta: Meta<typeof ReactionBubble> = {
  title: 'Atomic/ReactionBubble',
  component: ReactionBubble,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof ReactionBubble>;

export const Default: Story = {
  args: {
    emoji: '🔥',
    duration: 2000,
  },
};

export const Heart: Story = {
  args: {
    emoji: '❤️',
    duration: 2000,
  },
};
