import type { Meta, StoryObj } from '@storybook/react';
import { StatusBadge } from '../../components/atomic/StatusBadge';

const meta: Meta<typeof StatusBadge> = {
  title: 'Atomic/StatusBadge',
  component: StatusBadge,
  tags: ['autodocs'],
  argTypes: {
    status: {
      control: 'select',
      options: ['recording', 'live', 'transcribing', 'connecting', 'reconnecting'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Recording: Story = {
  args: {
    status: 'recording',
    pulse: true,
  },
};

export const Live: Story = {
  args: {
    status: 'live',
  },
};

export const Connecting: Story = {
  args: {
    status: 'connecting',
    pulse: true,
  },
};
