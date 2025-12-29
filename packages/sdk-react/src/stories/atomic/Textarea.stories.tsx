import type { Meta, StoryObj } from '@storybook/react';
import { Textarea } from '../../components/atomic/Textarea';

const meta: Meta<typeof Textarea> = {
  title: 'Atomic/Textarea',
  component: Textarea,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof Textarea>;

export const Default: Story = {
  args: {
    label: 'Message',
    placeholder: 'Type your message here...',
  },
};

export const WithCharacterCount: Story = {
  args: {
    label: 'Bio',
    placeholder: 'Tell us about yourself...',
    maxLength: 500,
    showCount: true,
  },
};

export const WithError: Story = {
  args: {
    label: 'Feedback',
    error: 'This field is required',
  },
};
