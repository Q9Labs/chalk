import type { Meta, StoryObj } from '@storybook/react';
import { TypingIndicator } from '../../components/composite/TypingIndicator';

const meta: Meta<typeof TypingIndicator> = {
  title: 'Composite/TypingIndicator',
  component: TypingIndicator,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof TypingIndicator>;

export const OneUser: Story = {
  args: {
    typingUsers: ['John Doe'],
  },
};

export const MultipleUsers: Story = {
  args: {
    typingUsers: ['John Doe', 'Jane Smith'],
  },
};
