import type { Meta, StoryObj } from '@storybook/react';
import { Spinner } from '../../components/atomic/Spinner';

const meta: Meta<typeof Spinner> = {
  title: 'Atomic/Spinner',
  component: Spinner,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg', 'xl'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Spinner>;

export const Default: Story = {
  args: {
    size: 'md',
  },
};

export const Large: Story = {
  args: {
    size: 'lg',
    color: 'var(--chalk-accent)',
  },
};

export const CustomColor: Story = {
  args: {
    size: 'md',
    color: '#ef4444',
  },
};
