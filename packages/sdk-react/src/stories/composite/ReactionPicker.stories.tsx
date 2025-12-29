import type { Meta, StoryObj } from '@storybook/react';
import { ReactionPicker } from '../../components/composite/ReactionPicker';

const meta: Meta<typeof ReactionPicker> = {
  title: 'Composite/ReactionPicker',
  component: ReactionPicker,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof ReactionPicker>;

export const Default: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    onSelect: (emoji) => console.log('Selected:', emoji),
  },
};

export const WithRecent: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    onSelect: (emoji) => console.log('Selected:', emoji),
    recentReactions: ['🚀', '✨', '💎'],
  },
};
